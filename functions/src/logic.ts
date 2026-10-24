// Pure notifier logic: decides WHICH notifications to send on each run from a
// household's data. No I/O, no Firestore, no network and no npm dependencies
// (only the app's shared modules), so it can be tested with sample data (see
// logic.test.ts).
//
// Every message is language-neutral (dedupe key, tag, link, audience) and
// renders its title and body per language with the texts in i18n.ts. Its
// audience is an explicit list of accounts, picked by each person's choices
// (shared/notify.ts): what they want to hear about and when.
import { addDays, type DateStr, diffDays, isTimeStr, parts, zonedParts, zonedToUtc } from '../../src/shared/dates';
import { LIMITS } from '../../src/shared/limits';
import { ACTIVITY_KINDS, DAILY_HOURS, type ResolvedNotify, resolveNotify } from '../../src/shared/notify';
import { expandEvents, nextKeyDate, type Occurrence, occursOn } from '../../src/shared/recurrence';
import { ALLDAY_BASE_MIN, MAX_REMINDER_MINS } from '../../src/shared/reminders';
import { type Route, routePath } from '../../src/shared/routes';
import { clip } from '../../src/shared/text';
import type {
  Activity,
  ActivityKind,
  CalEvent,
  Household,
  KeyDate,
  KeyDateKind,
  Lang,
  Member,
  MenuDay,
  Task,
} from '../../src/shared/types';
import { fmtTime, type Texts, texts } from './i18n';

// ---------- constants ----------

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const DEFAULT_TZ = 'Europe/Madrid';
/**
 * A reminder is sent up to this long after it was due (late or failed runs);
 * the record of sent keys keeps it from repeating.
 */
const REMINDER_CATCHUP = 45 * MINUTE;
/** …but not once its (timed) event started more than this long ago. */
const REMINDER_GRACE_AFTER_START = 10 * MINUTE;
/** Days after today whose events can have a reminder due today (the longest option, rounded up). */
export const REMINDER_LOOKAHEAD_DAYS = Math.ceil(MAX_REMINDER_MINS / 1440) + 1;
/** Activity older than this is no longer notified (only marked). */
const ACTIVITY_MAX_AGE = 12 * HOUR;
/** Local hour from which key dates are announced. */
export const KEYDATE_HOUR = 9;
/** The daily summary can be sent during these many hours from `dailyHour`. */
const DAILY_WINDOW_HOURS = 3;

/** How long push services keep a notification for an offline device (seconds). */
const ACTIVITY_TTL_S = 60 * 60;
const MIN_TTL_S = 5 * 60;

const MAX_DAILY_EVENTS = 6;
const MAX_TASK_TITLES = 3;
const MAX_ACTIVITY_ITEMS = 8;
/** Each item of an activity digest ("milk", "Dentist") is cut to this many characters. */
const ACTIVITY_ITEM_CHARS = 80;

// ---------- types ----------

export type MessageKind = 'reminder' | 'keydate' | 'daily' | 'activity';

export interface MessageText {
  title: string;
  body: string;
}

export interface Message {
  /** Dedupe key: a message with a key is sent once. Activity has none. */
  key?: string;
  kind: MessageKind;
  /** App path the notification opens. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
  urgency: 'high' | 'normal';
  /** Accounts whose devices get it. */
  toUids: string[];
  /** Seconds the push service keeps it for a device that's offline. */
  ttl: number;
  /** Title and body in a language. */
  render(lang: Lang): MessageText;
}

/** Who can be notified (members with a device), each with their choices resolved. */
export type Recipients = ReadonlyMap<string, ResolvedNotify>;

export interface ComputeInput {
  household: Household;
  recipients: Recipients;
  events: CalEvent[];
  tasks: Task[];
  menuToday?: MenuDay | null;
  keyDates: KeyDate[];
  activity: Activity[];
  now: number;
}

export interface ComputeResult {
  /** Everything due now, including what may have been sent already (the caller filters by key). */
  messages: Message[];
  activityIdsToMark: string[];
  /**
   * Morning summaries done for today without a message (nothing to say, turned
   * off, window over, no device): record them as sent.
   */
  quietKeys: string[];
}

// ---------- settings ----------

const tzValid = new Map<string, boolean>();
/** The household's time zone (or Europe/Madrid if missing or invalid). */
export function householdTz(h: Pick<Household, 'timezone'>): string {
  const tz = h.timezone;
  if (!tz) return DEFAULT_TZ;
  let ok = tzValid.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    tzValid.set(tz, ok);
  }
  return ok ? tz : DEFAULT_TZ;
}

/** Dedupe key of a person's morning summary. */
export const dailyKey = (date: DateStr, uid: string) => `daily_${date}_${uid}`;
/** Household-wide key of earlier versions: still means "sent" for everyone that day. */
export const legacyDailyKey = (date: DateStr) => `daily_${date}`;

/**
 * Earliest local hour at which someone's morning summary can be due: the
 * earliest the app offers, or the household's own setting from earlier versions.
 */
export function dailyGateHour(household: Pick<Household, 'notify'>): number {
  return Math.min(...DAILY_HOURS, resolveNotify(household, null).dailyHour);
}

/** Where a person's morning summary stands at local `hour`. No device or turned off ⇒ nothing to do today. */
function dailyStatus(r: ResolvedNotify | undefined, hour: number): 'open' | 'later' | 'done' {
  if (!r?.daily || hour >= r.dailyHour + DAILY_WINDOW_HOURS) return 'done';
  return hour < r.dailyHour ? 'later' : 'open';
}

/** People whose morning summary window is open at local `hour`. */
export function openDailyUids(recipients: Recipients, hour: number): string[] {
  return [...recipients].filter(([, r]) => dailyStatus(r, hour) === 'open').map(([uid]) => uid);
}

const ALL_ON: ResolvedNotify = {
  activity: Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, true])) as Record<ActivityKind, boolean>,
  reminders: true,
  keyDates: true,
  daily: false,
  dailyHour: 0,
};

/**
 * Every member as if they wanted everything but the morning summary: to find
 * out whether anything is due at all before reading anyone's choices.
 */
export const everyone = (h: Pick<Household, 'memberUids'>): Recipients =>
  new Map(h.memberUids.map((uid) => [uid, ALL_ON]));

const whoWants = (recipients: Recipients, wants: (r: ResolvedNotify) => boolean) =>
  [...recipients].filter(([, r]) => wants(r)).map(([uid]) => uid);

// ---------- helpers ----------

const endOfDay = (date: DateStr, tz: string) => zonedToUtc(addDays(date, 1), '00:00', tz);
/** TTL (seconds) for a notification that's pointless after `until`. */
const ttlUntil = (until: number, now: number) => Math.max(MIN_TTL_S, Math.ceil((until - now) / 1000));

function memberNames(ids: string[] | undefined, members: Member[], tx: Texts): string {
  if (!ids?.length) return '';
  const byId = new Map(members.map((m) => [m.id, clip(m.name.trim(), LIMITS.memberName)]));
  return tx.list(ids.map((id) => byId.get(id) ?? ''));
}

// ---------- event reminders ----------

/** A reminder the notifier honours: a whole number of minutes up to the longest option the app offers. */
const validReminder = (m: unknown): m is number =>
  typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= MAX_REMINDER_MINS;

/**
 * Instant at which an occurrence's reminder fires.
 * - Timed: start − reminderMins. Whole days are counted in wall-clock time
 *   ("1 day before" 10:00 is at 10:00 even across a DST change) and the rest
 *   in real minutes (30 min before is 30 real minutes).
 * - All day: relative to 09:00 wall-clock time, so 780 is always "20:00 the
 *   day before" even if the clocks change that night.
 */
export function reminderFireAt(ev: Pick<CalEvent, 'startTime' | 'reminderMins'>, date: DateStr, tz: string): number {
  const mins = ev.reminderMins ?? 0;
  if (isTimeStr(ev.startTime)) {
    const days = Math.floor(mins / 1440);
    return zonedToUtc(addDays(date, -days), ev.startTime, tz) - (mins - days * 1440) * MINUTE;
  }
  const total = ALLDAY_BASE_MIN - mins;
  const dayOff = Math.floor(total / 1440);
  const m = total - dayOff * 1440;
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return zonedToUtc(addDays(date, dayOff), hhmm, tz);
}

function reminderBody(o: Occurrence, today: DateStr, members: Member[], tx: Texts): string {
  const ev = o.event;
  let when = tx.reminderWhen(o.date, isTimeStr(ev.startTime) ? ev.startTime : null, today);
  if (o.endDate > o.date) when += tx.until(o.endDate);
  const bits = [when];
  const names = memberNames(ev.memberIds, members, tx);
  if (names) bits.push(names);
  const place = clip(ev.location?.trim() ?? '', LIMITS.place);
  if (place) bits.push(place);
  return bits.join(' · ');
}

function eventReminders(
  events: CalEvent[],
  members: Member[],
  to: string[],
  tz: string,
  today: DateStr,
  now: number,
): Message[] {
  const withRem = events.filter((e) => validReminder(e.reminderMins));
  if (!withRem.length || !to.length) return [];
  const from = addDays(today, -1);
  const out: Message[] = [];
  for (const o of expandEvents(withRem, from, addDays(today, REMINDER_LOOKAHEAD_DAYS))) {
    if (o.date < from) continue; // multi-day event that started earlier: its reminder is long gone
    const ev = o.event;
    const fireAt = reminderFireAt(ev, o.date, tz);
    if (fireAt > now || fireAt <= now - REMINDER_CATCHUP) continue;
    const startTime = isTimeStr(ev.startTime) ? ev.startTime : null;
    const start = startTime ? zonedToUtc(o.date, startTime, tz) : null;
    if (start !== null && now > start + REMINDER_GRACE_AFTER_START) continue;
    out.push({
      key: `ev_${ev.id}_${o.date}_${ev.reminderMins}`,
      kind: 'reminder',
      url: routePath('calendar'),
      tag: `ev_${ev.id}_${o.date}`,
      urgency: 'high',
      toUids: to,
      ttl: ttlUntil(start !== null ? start + REMINDER_GRACE_AFTER_START : endOfDay(o.date, tz), now),
      render(lang) {
        const tx = texts(lang);
        return {
          title: clip(ev.title.trim(), LIMITS.title) || tx.untitledEvent,
          body: reminderBody(o, today, members, tx),
        };
      },
    });
  }
  return out;
}

// ---------- key dates ----------

const KD_EMOJI: Record<KeyDateKind, string> = {
  birthday: '🎂',
  car: '🚗',
  insurance: '🛡️',
  bill: '🧾',
  health: '🩺',
  school: '🎒',
  other: '📌',
};
/** Kinds that "fall due" (Vence… / Due…). */
const KD_DUE: ReadonlySet<string> = new Set(['car', 'insurance', 'bill']);
/** Birthday titles that already say so ("Cumple de la abuela", "Grandma's birthday") are kept as is. */
const SAYS_BIRTHDAY = /^cumple|birthday/i;

const hasAmount = (kd: KeyDate): kd is KeyDate & { amount: number } => typeof kd.amount === 'number' && kd.amount > 0;

/** Next date (>= today). Birthdays repeat every year even if stored wrongly. */
function keyDateNext(kd: KeyDate, today: DateStr): DateStr | null {
  return nextKeyDate(kd.kind === 'birthday' ? { ...kd, repeat: 'yearly' } : kd, today);
}

/** Age turned on `d` (null if the date of birth has no credible year). */
function birthdayAge(kd: KeyDate, d: DateStr): number | null {
  const born = parts(kd.date).y;
  const age = parts(d).y - born;
  return born >= 1900 && age >= 1 && age < 130 ? age : null;
}

function keyDateTitle(kd: KeyDate, tx: Texts): string {
  const t = clip(kd.title.trim(), LIMITS.title);
  if (kd.kind === 'birthday') return `🎂 ${SAYS_BIRTHDAY.test(t) ? t : tx.birthdayOf(t)}`;
  return `${KD_EMOJI[kd.kind] ?? KD_EMOJI.other} ${t || tx.untitledKeyDate}`;
}

function keyDateBody(kd: KeyDate, d: DateStr, today: DateStr, tx: Texts): string {
  const n = diffDays(d, today);
  if (kd.kind === 'birthday') return tx.birthdayBody(n, birthdayAge(kd, d), d, today);
  const body = tx.keyDateBody(n, KD_DUE.has(kd.kind), d, today);
  return hasAmount(kd) ? `${body} · ${tx.money(kd.amount)}` : body;
}

function keyDateMessages(
  keyDates: KeyDate[],
  to: string[],
  today: DateStr,
  hour: number,
  tz: string,
  now: number,
): Message[] {
  if (hour < KEYDATE_HOUR || !to.length) return [];
  const out: Message[] = [];
  for (const kd of keyDates) {
    const d = keyDateNext(kd, today);
    if (!d) continue;
    const diff = diffDays(d, today);
    const rd = Math.max(0, Math.trunc(Number(kd.remindDays) || 0));
    const fire: number[] = [];
    if (diff === rd) fire.push(rd);
    if (rd > 0 && diff === 0) fire.push(0);
    for (const r of fire) {
      out.push({
        key: `kd_${kd.id}_${d}_${r}`,
        kind: 'keydate',
        url: routePath('dates'),
        tag: `kd_${kd.id}_${d}`,
        urgency: 'normal',
        toUids: to,
        ttl: ttlUntil(endOfDay(today, tz), now),
        render(lang) {
          const tx = texts(lang);
          return { title: keyDateTitle(kd, tx), body: keyDateBody(kd, d, today, tx) };
        },
      });
    }
  }
  return out;
}

// ---------- daily summary ----------

interface DailyContent {
  today: DateStr;
  hour: number;
  events: { time: string | null; title: string }[];
  lunch: string;
  dinner: string;
  tasks: Task[];
  keyDates: KeyDate[];
}

function renderDaily(c: DailyContent, tx: Texts): MessageText {
  const { today } = c;
  const byTitle = (a: string, b: string) => a.localeCompare(b, tx.locale);
  const lines: string[] = [];

  // Today's events: all-day ones (or ones carried over from earlier days) first.
  const rows = c.events
    .map((e) => ({
      sort: e.time ?? '',
      label: e.time ? fmtTime(e.time) : tx.allDay,
      title: e.title || tx.untitledEvent,
    }))
    .sort((a, b) => (a.sort === b.sort ? byTitle(a.title, b.title) : a.sort < b.sort ? -1 : 1));
  for (const r of rows.slice(0, MAX_DAILY_EVENTS)) lines.push(`${r.label} · ${r.title}`);
  if (rows.length > MAX_DAILY_EVENTS) lines.push(tx.moreEvents(rows.length - MAX_DAILY_EVENTS));

  const meal: string[] = [];
  if (c.lunch) meal.push(`${tx.lunch}: ${c.lunch}`);
  if (c.dinner) meal.push(`${tx.dinner}: ${c.dinner}`);
  if (meal.length) lines.push(`🍽️ ${meal.join(' · ')}`);

  // Tasks due today or overdue (oldest first)
  const due = c.tasks
    .map((t) => ({ title: clip(t.title.trim(), LIMITS.title), due: t.due ?? today }))
    .sort((a, b) => (a.due === b.due ? byTitle(a.title, b.title) : a.due < b.due ? -1 : 1));
  const [first] = due;
  if (first && due.length === 1) {
    lines.push(`✅ ${tx.oneTask(first.title, first.due < today)}`);
  } else if (due.length > 1) {
    const overdue = due.filter((t) => t.due < today).length;
    lines.push(
      `✅ ${tx.manyTasks(
        due.length,
        overdue,
        tx.list(
          due.map((t) => t.title),
          MAX_TASK_TITLES,
        ),
      )}`,
    );
  }

  for (const kd of c.keyDates) {
    let l = keyDateTitle(kd, tx);
    if (kd.kind === 'birthday') {
      const age = birthdayAge(kd, today);
      if (age != null) l += ` (${tx.ageNote(age)})`;
    } else {
      if (KD_DUE.has(kd.kind)) l += ` · ${tx.dueToday}`;
      if (hasAmount(kd)) l += ` · ${tx.money(kd.amount)}`;
    }
    lines.push(l);
  }

  return { title: `${tx.greeting(c.hour)} · ${tx.dayName(today)}`, body: lines.join('\n') };
}

/**
 * Morning summaries due now, one per person whose window is open (each in
 * their own hour), and the people for whom it's done today without a message.
 */
function dailySummaries(input: ComputeInput): { messages: Message[]; quietKeys: string[] } {
  const { household, recipients, now } = input;
  const tz = householdTz(household);
  const { date: today, hour } = zonedParts(now, tz);
  const quietKeys: string[] = [];
  const open: [string, ResolvedNotify][] = [];
  for (const uid of household.memberUids) {
    const r = recipients.get(uid);
    const status = dailyStatus(r, hour);
    if (r && status === 'open') open.push([uid, r]);
    else if (status === 'done') quietKeys.push(dailyKey(today, uid));
  }
  if (!open.length) return { messages: [], quietKeys };

  const content: DailyContent = {
    today,
    hour,
    events: expandEvents(input.events, today, today)
      .filter((o) => occursOn(o, today))
      .map((o) => {
        const t = o.event.startTime;
        return {
          time: isTimeStr(t) && o.date === today ? t : null,
          title: clip(o.event.title.trim(), LIMITS.title),
        };
      }),
    lunch: clip(input.menuToday?.lunch?.trim() ?? '', LIMITS.dish),
    dinner: clip(input.menuToday?.dinner?.trim() ?? '', LIMITS.dish),
    tasks: input.tasks.filter((t) => !t.done && typeof t.due === 'string' && t.due <= today),
    keyDates: input.keyDates.filter((kd) => keyDateNext(kd, today) === today),
  };
  const { events, lunch, dinner, tasks, keyDates } = content;
  if (!events.length && !lunch && !dinner && !tasks.length && !keyDates.length) {
    return { messages: [], quietKeys: [...quietKeys, ...open.map(([uid]) => dailyKey(today, uid))] };
  }

  const messages = open.map(([uid, r]): Message => {
    const windowEnd = r.dailyHour + DAILY_WINDOW_HOURS;
    const until = windowEnd >= 24 ? endOfDay(today, tz) : zonedToUtc(today, `${windowEnd}:00`, tz);
    return {
      key: dailyKey(today, uid),
      kind: 'daily',
      url: routePath('home'),
      tag: legacyDailyKey(today),
      urgency: 'normal',
      toUids: [uid],
      ttl: ttlUntil(until, now),
      render: (lang) => renderDaily(content, texts(lang)),
    };
  });
  return { messages, quietKeys };
}

// ---------- activity ----------

const KIND_ORDER: ActivityKind[] = ['shopping', 'event', 'task', 'date', 'expense', 'note', 'menu'];
/** App screen that each kind of activity opens. */
const KIND_ROUTE: Record<ActivityKind, Route> = {
  shopping: 'shopping',
  event: 'calendar',
  task: 'tasks',
  date: 'dates',
  expense: 'expenses',
  note: 'notes',
  menu: 'menu',
};

/** Oldest first; same instant ⇒ by id, so every run agrees on which one is the latest. */
export const byCreation = (a: Activity, b: Activity) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Who did it: the household member linked to the account, else the name the app sent. */
function actorName(actorUid: string, fallback: string, members: Member[] | undefined): string {
  const member = actorUid ? members?.find((m) => m.uid === actorUid) : undefined;
  return clip((member?.name || fallback).trim(), LIMITS.memberName);
}

/**
 * One notification per person with what they added, to everyone else who has
 * those kinds on; each recipient only sees the lines of the kinds they chose
 * (nothing left ⇒ no message). By default only counts what wasn't notified
 * yet; the instant function passes `includeNotified` to rebuild the
 * notification for the whole burst (same tag ⇒ it replaces the previous one
 * on the phone).
 */
export function activityDigest(
  activity: Activity[],
  now: number,
  recipients: Recipients,
  opts: { includeNotified?: boolean; members?: Member[] } = {},
): Message[] {
  const recent = activity
    .filter((a) => (opts.includeNotified || !a.notified) && a.createdAt >= now - ACTIVITY_MAX_AGE)
    .sort(byCreation);
  const byActor = new Map<string, Activity[]>();
  for (const a of recent) {
    const list = byActor.get(a.actorUid) ?? [];
    list.push(a);
    byActor.set(a.actorUid, list);
  }
  const out: Message[] = [];
  for (const [actorUid, items] of byActor) {
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) continue;
    // Group by kind and drop duplicates (the same thing added twice, case-insensitive).
    const byKind = new Map<string, { texts: string[]; count: number }>();
    for (const a of items) {
      const g = byKind.get(a.kind) ?? { texts: [], count: 0 };
      g.count++;
      const t = clip(a.text.trim(), ACTIVITY_ITEM_CHARS);
      if (t && !g.texts.some((x) => x.toLowerCase() === t.toLowerCase())) g.texts.push(t);
      byKind.set(a.kind, g);
    }
    const order = (k: string) => {
      const i = KIND_ORDER.indexOf(k as ActivityKind);
      return i < 0 ? 99 : i;
    };
    const count = (k: string) => byKind.get(k)?.count ?? 0;
    const kinds = [...byKind.keys()].sort((a, b) => count(b) - count(a) || order(a) - order(b));

    // Recipients grouped by the kinds of this burst they want (never the actor).
    const groups = new Map<string, { kinds: string[]; uids: string[] }>();
    for (const [uid, r] of recipients) {
      if (uid === actorUid) continue;
      const wanted = kinds.filter((k) => r.activity[k as ActivityKind] === true);
      if (!wanted.length) continue;
      const id = wanted.join(',');
      const g = groups.get(id) ?? { kinds: wanted, uids: [] };
      g.uids.push(uid);
      groups.set(id, g);
    }

    const name = actorName(actorUid, last.actorName, opts.members);
    for (const g of groups.values()) {
      const dominant = KIND_ROUTE[g.kinds[0] as ActivityKind] as Route | undefined;
      out.push({
        kind: 'activity',
        url: routePath(dominant ?? 'home'),
        tag: `act_${actorUid || 'anon'}_${first.createdAt}`,
        urgency: 'normal',
        toUids: g.uids,
        ttl: ACTIVITY_TTL_S,
        render(lang) {
          const tx = texts(lang);
          return {
            title: name || tx.someone,
            body: g.kinds.map((k) => tx.activityLine(k, byKind.get(k)?.texts ?? [], MAX_ACTIVITY_ITEMS)).join('\n'),
          };
        },
      });
    }
  }
  return out;
}

// ---------- main entry point ----------

/**
 * Computes what a household has due right now, and for whom. The lists may
 * come pre-filtered (see run.ts): it's enough that they include the events
 * that start or fall within [today−1, today+REMINDER_LOOKAHEAD_DAYS], the
 * recurring ones and the key dates, plus the pending tasks and today's menu
 * when someone's morning summary is due. Messages already sent are not
 * filtered out here: the caller drops the ones whose key it has recorded.
 */
export function computeNotifications(input: ComputeInput): ComputeResult {
  const { household, recipients, now } = input;
  const tz = householdTz(household);
  const { date: today, hour } = zonedParts(now, tz);
  const members = household.members ?? [];

  const daily = dailySummaries(input);
  const messages: Message[] = [
    ...eventReminders(
      input.events,
      members,
      whoWants(recipients, (r) => r.reminders),
      tz,
      today,
      now,
    ),
    ...keyDateMessages(
      input.keyDates,
      whoWants(recipients, (r) => r.keyDates),
      today,
      hour,
      tz,
      now,
    ),
    ...daily.messages,
    ...activityDigest(input.activity, now, recipients, { members }),
  ];

  // All pending activity is marked (even if nobody wants it or it's old) so it doesn't pile up.
  const activityIdsToMark = input.activity.filter((a) => !a.notified).map((a) => a.id);
  return { messages, activityIdsToMark, quietKeys: daily.quietKeys };
}
