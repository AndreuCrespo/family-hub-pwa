// Turns Firestore documents into the typed shapes logic.ts works with. The
// data is written by the app (and anyone with a household's id could write
// junk), so nothing is trusted: malformed documents are dropped and bad fields
// replaced, so one bad document never stops a household's notifications.
import { isDateStr, isTimeStr } from '../../src/shared/dates';
import { toLang } from '../../src/shared/locale';
import type {
  Activity,
  ActivityKind,
  CalEvent,
  Device,
  Freq,
  Household,
  KeyDate,
  KeyDateKind,
  Member,
  MenuDay,
  NotifySettings,
  PersonalNotify,
  Recurrence,
  Task,
} from '../../src/shared/types';

export type Data = Record<string, unknown>;

const isRecord = (x: unknown): x is Data => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
const oneOf = <T extends string>(x: unknown, values: readonly T[], fallback: T): T =>
  values.includes(x as T) ? (x as T) : fallback;

const FREQS: readonly Freq[] = ['daily', 'weekly', 'monthly', 'yearly'];
const KEYDATE_KINDS: readonly KeyDateKind[] = ['birthday', 'car', 'insurance', 'bill', 'health', 'school', 'other'];

function parseMember(x: unknown): Member[] {
  if (!isRecord(x) || !str(x.id)) return [];
  return [
    {
      id: str(x.id),
      name: str(x.name),
      color: str(x.color),
      kind: x.kind === 'child' ? 'child' : 'adult',
      uid: str(x.uid) || null,
    },
  ];
}

export function parseHousehold(id: string, d: Data): Household {
  return {
    id,
    name: str(d.name),
    memberUids: strings(d.memberUids),
    members: Array.isArray(d.members) ? d.members.flatMap(parseMember) : [],
    timezone: str(d.timezone),
    // notifySettings() checks each field.
    notify: isRecord(d.notify) ? (d.notify as Partial<NotifySettings> as NotifySettings) : undefined,
    createdAt: num(d.createdAt) ?? 0,
  };
}

function parseRecurrence(x: unknown): Recurrence | null {
  if (!isRecord(x) || !FREQS.includes(x.freq as Freq)) return null;
  return {
    freq: x.freq as Freq,
    interval: num(x.interval) ?? 1,
    byWeekday: Array.isArray(x.byWeekday) ? x.byWeekday.filter((n): n is number => typeof n === 'number') : undefined,
    until: isDateStr(x.until) ? x.until : null,
  };
}

/** Null if it has no valid date. */
export function parseEvent(id: string, d: Data): CalEvent | null {
  if (!isDateStr(d.date)) return null;
  return {
    id,
    title: str(d.title),
    date: d.date,
    endDate: isDateStr(d.endDate) ? d.endDate : null,
    startTime: isTimeStr(d.startTime) ? d.startTime : null,
    endTime: isTimeStr(d.endTime) ? d.endTime : null,
    memberIds: strings(d.memberIds),
    recurrence: parseRecurrence(d.recurrence),
    exdates: strings(d.exdates).filter(isDateStr),
    reminderMins: num(d.reminderMins),
    location: str(d.location),
  };
}

export function parseTask(id: string, d: Data): Task {
  return {
    id,
    title: str(d.title),
    memberIds: strings(d.memberIds),
    due: isDateStr(d.due) ? d.due : null,
    done: d.done === true,
    createdAt: num(d.createdAt) ?? 0,
  };
}

/** Null if it has no valid date. */
export function parseKeyDate(id: string, d: Data): KeyDate | null {
  if (!isDateStr(d.date)) return null;
  return {
    id,
    title: str(d.title),
    kind: oneOf(d.kind, KEYDATE_KINDS, 'other'),
    date: d.date,
    repeat: oneOf(d.repeat, ['none', 'monthly', 'yearly'] as const, 'none'),
    remindDays: num(d.remindDays) ?? 0,
    amount: num(d.amount),
  };
}

/**
 * A person's notification choices from prefs/{uid} (null without any).
 * resolveNotify() checks each field, so only the shape matters here.
 */
export function parsePrefs(d: Data | undefined): PersonalNotify | null {
  return d && isRecord(d.notify) ? (d.notify as PersonalNotify) : null;
}

export function parseMenuDay(id: string, d: Data): MenuDay {
  return { id, lunch: str(d.lunch), dinner: str(d.dinner) };
}

/** Null if it can't receive anything (no owner or an incomplete subscription). */
export function parseDevice(id: string, d: Data): Device | null {
  const sub = isRecord(d.subscription) ? d.subscription : {};
  const keys = isRecord(sub.keys) ? sub.keys : {};
  const uid = str(d.uid);
  const endpoint = str(sub.endpoint);
  const p256dh = str(keys.p256dh);
  const auth = str(keys.auth);
  if (!uid || !endpoint || !p256dh || !auth) return null;
  return {
    id,
    uid,
    subscription: { endpoint, keys: { p256dh, auth } },
    ua: str(d.ua),
    createdAt: num(d.createdAt) ?? 0,
    lang: toLang(d.lang),
  };
}

/**
 * `createTime` is when Firestore created the document: the server's clock,
 * used instead of the `createdAt` the app wrote (its device's clock).
 */
export function parseActivity(id: string, d: Data, createTime?: number): Activity {
  return {
    id,
    actorUid: str(d.actorUid),
    actorName: str(d.actorName),
    kind: str(d.kind) as ActivityKind, // unknown kinds get a generic line
    text: str(d.text),
    createdAt: createTime ?? num(d.createdAt) ?? 0,
    notified: d.notified === true,
  };
}
