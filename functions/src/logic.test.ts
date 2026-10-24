// Tests of the notifier's pure logic (what to send and how it reads).
// The shared date/recurrence modules have their own tests in src/shared.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveNotify } from '../../src/shared/notify';
import type {
  Activity,
  CalEvent,
  Household,
  KeyDate,
  Lang,
  MenuDay,
  PersonalNotify,
  Task,
} from '../../src/shared/types';
import {
  activityDigest,
  type ComputeInput,
  computeNotifications,
  dailyGateHour,
  everyone,
  householdTz,
  type Message,
  openDailyUids,
  REMINDER_LOOKAHEAD_DAYS,
  type Recipients,
  reminderFireAt,
} from './logic';

const Z = (iso: string) => Date.parse(iso);
const TZ = 'Europe/Madrid';
const nb = (s: string) => s.replace(/ /g, ' '); // Spanish euro format uses a non-breaking space

// ---------- sample data ----------

const H: Household = {
  id: 'h1',
  name: 'Casa',
  timezone: TZ,
  createdAt: 0,
  memberUids: ['u1', 'u2'],
  members: [
    { id: 'm1', name: 'Alex', color: '#e11', kind: 'adult', uid: 'u1' },
    { id: 'm2', name: 'Sam', color: '#1e1', kind: 'adult', uid: 'u2' },
    { id: 'lia', name: 'Lía', color: '#11e', kind: 'child' },
    { id: 'noa', name: 'Noa', color: '#ee1', kind: 'child' },
    { id: 'iker', name: 'Iker', color: '#1ee', kind: 'child' },
  ],
};

const ev = (e: Partial<CalEvent> & Pick<CalEvent, 'id' | 'title' | 'date'>): CalEvent => ({ memberIds: [], ...e });

/** A message as one device sees it. */
interface Shown {
  key?: string;
  kind: Message['kind'];
  title: string;
  body: string;
  url: string;
  tag: string;
  urgency: Message['urgency'];
  toUids: Message['toUids'];
}
const show = (m: Message, lang: Lang): Shown => ({
  ...(m.key ? { key: m.key } : {}),
  kind: m.kind,
  ...m.render(lang),
  url: m.url,
  tag: m.tag,
  urgency: m.urgency,
  toUids: m.toUids,
});

/** Every member with a device, with these choices (none = the household defaults). */
const people = (household: Household, prefs: Record<string, PersonalNotify> = {}): Recipients =>
  new Map(household.memberUids.map((uid) => [uid, resolveNotify(household, prefs[uid] ?? null)]));

function compute(over: Partial<ComputeInput> & Pick<ComputeInput, 'now'>) {
  const household = over.household ?? H;
  return computeNotifications({
    household,
    recipients: people(household),
    events: [],
    tasks: [],
    menuToday: null,
    keyDates: [],
    activity: [],
    ...over,
  });
}
function run(over: Partial<ComputeInput> & Pick<ComputeInput, 'now'>, lang: Lang = 'es') {
  const r = compute(over);
  return { ...r, messages: r.messages.map((m) => show(m, lang)) };
}
const ofKind = (ms: Shown[], kind: Shown['kind']) => ms.filter((m) => m.kind === kind);

// =====================================================================
// Settings
// =====================================================================

test('without choices of their own, people get the household settings of earlier versions', () => {
  const old = { ...H, notify: { dailySummary: true, dailyHour: 10, activity: false } };
  const r = compute({
    household: old,
    now: Z('2026-10-22T08:05:00Z'), // 10:05
    menuToday: { id: '2026-10-22', lunch: 'Paella' },
    activity: [
      {
        id: 'a',
        actorUid: 'u1',
        actorName: 'Alex',
        kind: 'shopping',
        text: 'leche',
        createdAt: Z('2026-10-22T08:04:00Z'),
        notified: false,
      },
    ],
  });
  assert.deepEqual(
    r.messages.map((m) => m.key ?? m.kind),
    ['daily_2026-10-22_u1', 'daily_2026-10-22_u2'],
    'summary at 10, no activity',
  );
  assert.equal(dailyGateHour(old), 6);
  assert.equal(dailyGateHour({ notify: { dailySummary: true, dailyHour: 4, activity: true } }), 4);
});

test('householdTz: falls back to Madrid', () => {
  assert.equal(householdTz({ timezone: 'America/New_York' }), 'America/New_York');
  assert.equal(householdTz({ timezone: '' }), 'Europe/Madrid');
  assert.equal(householdTz({ timezone: 'Mars/Olympus' }), 'Europe/Madrid');
});

// =====================================================================
// Event reminders
// =====================================================================

const dentista = ev({
  id: 'dent',
  title: 'Dentista',
  date: '2026-10-22',
  startTime: '17:00',
  endTime: '17:30',
  reminderMins: 60,
  memberIds: ['lia', 'noa'],
  location: 'Clínica Sonrisas',
});

test('timed event reminder', () => {
  const r = run({ events: [dentista], now: Z('2026-10-22T14:05:00Z') });
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.messages[0], {
    key: 'ev_dent_2026-10-22_60',
    kind: 'reminder',
    title: 'Dentista',
    body: 'Hoy a las 17:00 · Lía y Noa · Clínica Sonrisas',
    url: '/#/calendar',
    tag: 'ev_dent_2026-10-22',
    urgency: 'high',
    toUids: ['u1', 'u2'],
  });
  // a different reminder is a different key
  assert.equal(
    run({ events: [{ ...dentista, reminderMins: 30 }], now: Z('2026-10-22T14:35:00Z') }).messages[0]?.key,
    'ev_dent_2026-10-22_30',
  );
  // no reminder
  assert.equal(
    run({ events: [{ ...dentista, reminderMins: null }], now: Z('2026-10-22T14:05:00Z') }).messages.length,
    0,
  );
});

test('reminder window: due, caught up for 45 min, never after the event started', () => {
  const fire = Z('2026-10-22T14:00:00Z'); // 16:00, an hour before
  const n = (now: number, e: CalEvent = dentista) => run({ events: [e], now }).messages.length;
  assert.equal(n(fire - 60_000), 0); // not yet
  assert.equal(n(fire), 1); // fireAt == now
  // Repeated on every run of the catch-up window: the caller drops the keys already sent,
  // so a delivery that failed is retried.
  assert.equal(n(fire + 10 * 60_000), 1);
  assert.equal(n(fire + 44 * 60_000), 1);
  assert.equal(n(fire + 46 * 60_000), 0);
  // "At the time" reminders: still useful just after the start, not 10 minutes later.
  const atTime = { ...dentista, reminderMins: 0 };
  const start = Z('2026-10-22T15:00:00Z');
  assert.equal(n(start + 4 * 60_000, atTime), 1);
  assert.equal(n(start + 9 * 60_000, atTime), 1);
  assert.equal(n(start + 11 * 60_000, atTime), 0);
});

test('reminders longer than the app offers are ignored (and not looked for)', () => {
  assert.equal(REMINDER_LOOKAHEAD_DAYS, 2);
  const week = ev({ id: 'via', title: 'Viaje', date: '2026-10-29', startTime: '08:00', reminderMins: 7 * 1440 });
  assert.equal(run({ events: [week], now: Z('2026-10-22T06:05:00Z') }).messages.length, 0);
  const odd = ev({ id: 'odd', title: 'Raro', date: '2026-10-22', startTime: '17:00', reminderMins: 30.5 });
  assert.equal(run({ events: [odd], now: Z('2026-10-22T14:30:00Z') }).messages.length, 0);
});

test('weekly event reminder (and exdates)', () => {
  const nat = ev({
    id: 'nat',
    title: 'Natación',
    date: '2026-09-03',
    startTime: '17:30',
    reminderMins: 30,
    memberIds: ['lia'],
    recurrence: { freq: 'weekly', interval: 1 },
  });
  const now = Z('2026-10-22T15:05:00Z');
  const r = run({ events: [nat], now });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0]?.key, 'ev_nat_2026-10-22_30');
  assert.equal(r.messages[0]?.body, 'Hoy a las 17:30 · Lía');
  assert.equal(run({ events: [{ ...nat, exdates: ['2026-10-22'] }], now }).messages.length, 0);
  assert.equal(
    run({ events: [{ ...nat, recurrence: { freq: 'weekly', interval: 1, until: '2026-10-15' } }], now }).messages
      .length,
    0,
  );
});

test('weekly event across the autumn DST change', () => {
  const merc = ev({
    id: 'merc',
    title: 'Mercadillo',
    date: '2026-10-04',
    startTime: '10:00',
    reminderMins: 0,
    recurrence: { freq: 'weekly', interval: 1 },
  });
  // 18-10 (CEST): 10:00 = 08:00Z
  assert.equal(run({ events: [merc], now: Z('2026-10-18T08:02:00Z') }).messages[0]?.key, 'ev_merc_2026-10-18_0');
  // 25-10 (CET): 10:00 = 09:00Z, not 08:00Z (the daily summary does go out at that time)
  assert.equal(ofKind(run({ events: [merc], now: Z('2026-10-25T08:58:00Z') }).messages, 'reminder').length, 0);
  const r = ofKind(run({ events: [merc], now: Z('2026-10-25T09:05:00Z') }).messages, 'reminder');
  assert.equal(r.length, 1);
  assert.equal(r[0]?.key, 'ev_merc_2026-10-25_0');
  assert.equal(r[0]?.body, 'Hoy a las 10:00');
});

test('reminder for "tomorrow" and one just after midnight', () => {
  const rev = ev({ id: 'rev', title: 'Revisión', date: '2026-10-23', startTime: '10:00', reminderMins: 1440 });
  assert.equal(
    ofKind(run({ events: [rev], now: Z('2026-10-22T08:05:00Z') }).messages, 'reminder')[0]?.body,
    'Mañana a las 10:00',
  );
  // 23:55 yesterday, "at the time": still sent at 00:02.
  const late = ev({ id: 'late', title: 'Pastilla', date: '2026-10-21', startTime: '23:55', reminderMins: 0 });
  assert.equal(run({ events: [late], now: Z('2026-10-21T22:02:00Z') }).messages[0]?.body, 'Ayer a las 23:55');
});

test('all-day event reminder', () => {
  const exc = ev({ id: 'exc', title: 'Excursión', date: '2026-10-23', reminderMins: 780, memberIds: ['lia', 'iker'] });
  // 780 → 20:00 the day before (CEST: 18:00Z)
  assert.equal(reminderFireAt(exc, '2026-10-23', TZ), Z('2026-10-22T18:00:00Z'));
  const r = run({ events: [exc], now: Z('2026-10-22T18:05:00Z') });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0]?.title, 'Excursión');
  assert.equal(r.messages[0]?.body, 'Mañana, todo el día · Lía e Iker');
  assert.equal(r.messages[0]?.key, 'ev_exc_2026-10-23_780');
  // 0 → 09:00 the same day
  const sinCole = ev({ id: 'sc', title: 'Día sin cole', date: '2026-10-22', reminderMins: 0 });
  assert.equal(reminderFireAt(sinCole, '2026-10-22', TZ), Z('2026-10-22T07:00:00Z'));
  assert.equal(
    ofKind(run({ events: [sinCole], now: Z('2026-10-22T07:05:00Z') }).messages, 'reminder')[0]?.body,
    'Hoy, todo el día',
  );
  // multi-day
  const vac = ev({ id: 'vac', title: 'Vacaciones', date: '2026-10-24', endDate: '2026-10-27', reminderMins: 780 });
  assert.equal(
    run({ events: [vac], now: Z('2026-10-23T18:05:00Z') }).messages[0]?.body,
    'Mañana, todo el día (hasta el martes 27)',
  );
});

test('reminders across DST changes (Europe/Madrid)', () => {
  // All day, 780: always 20:00 wall-clock time the day before.
  assert.equal(reminderFireAt({ reminderMins: 780 }, '2026-10-26', TZ), Z('2026-10-25T19:00:00Z')); // 20:00 CET
  assert.equal(reminderFireAt({ reminderMins: 780 }, '2026-10-25', TZ), Z('2026-10-24T18:00:00Z')); // 20:00 CEST
  assert.equal(reminderFireAt({ reminderMins: 780 }, '2026-03-29', TZ), Z('2026-03-28T19:00:00Z')); // 20:00 CET
  assert.equal(reminderFireAt({ reminderMins: 780 }, '2026-03-30', TZ), Z('2026-03-29T18:00:00Z')); // 20:00 CEST
  assert.equal(reminderFireAt({ reminderMins: 1440 }, '2026-03-30', TZ), Z('2026-03-29T07:00:00Z')); // 09:00 CEST
  // Timed: loose minutes are real minutes (03:30 CEST − 60 min = 01:30 CET)…
  assert.equal(reminderFireAt({ startTime: '03:30', reminderMins: 60 }, '2026-03-29', TZ), Z('2026-03-29T00:30:00Z'));
  assert.equal(reminderFireAt({ startTime: '10:00', reminderMins: 120 }, '2026-03-29', TZ), Z('2026-03-29T06:00:00Z'));
  // …and whole days are wall-clock time: "1 day before" 10:00 is at 10:00.
  assert.equal(reminderFireAt({ startTime: '10:00', reminderMins: 1440 }, '2026-03-30', TZ), Z('2026-03-29T08:00:00Z'));
  assert.equal(reminderFireAt({ startTime: '10:00', reminderMins: 1440 }, '2026-10-26', TZ), Z('2026-10-25T09:00:00Z'));
  assert.equal(
    reminderFireAt({ startTime: '08:00', reminderMins: 7 * 1440 }, '2026-10-29', TZ),
    Z('2026-10-22T06:00:00Z'),
  );
  assert.equal(
    reminderFireAt({ startTime: '10:00', reminderMins: 1440 + 30 }, '2026-10-26', TZ),
    Z('2026-10-25T08:30:00Z'),
  );
  // Repeated hour in the early morning of 25-10: fires at 02:00 CEST (00:00Z) and
  // not again when it's 02:00 once more (CET, 01:00Z).
  const e = ev({ id: 'noct', title: 'Toma de medicina', date: '2026-10-25', startTime: '02:00', reminderMins: 0 });
  const r = run({ events: [e], now: Z('2026-10-25T00:05:00Z') });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0]?.body, 'Hoy a las 2:00');
  assert.equal(run({ events: [e], now: Z('2026-10-25T01:05:00Z') }).messages.length, 0);
  // The all-day one on 29-03 fires on Saturday at 20:00 CET.
  const t = ev({ id: 'pri', title: 'Ruta', date: '2026-03-29', reminderMins: 780 });
  assert.equal(run({ events: [t], now: Z('2026-03-28T19:00:00Z') }).messages[0]?.body, 'Mañana, todo el día');
  assert.equal(run({ events: [t], now: Z('2026-03-28T18:55:00Z') }).messages.length, 0);
});

test('reminders: untitled, long titles and how long push services keep them', () => {
  const untitled = run({ events: [{ ...dentista, title: '  ' }], now: Z('2026-10-22T14:05:00Z') });
  assert.equal(untitled.messages[0]?.title, 'Evento');
  const long = run({ events: [{ ...dentista, title: 'x'.repeat(5000) }], now: Z('2026-10-22T14:05:00Z') });
  assert.equal(Array.from(long.messages[0]?.title ?? '').length, 200);
  // TTL: until 10 min after the start (17:10 = 15:10Z), from 14:05Z
  const [m] = compute({ events: [dentista], now: Z('2026-10-22T14:05:00Z') }).messages;
  assert.equal(m?.ttl, 65 * 60);
});

// =====================================================================
// Daily summary
// =====================================================================

const dayEvents: CalEvent[] = [
  ev({
    id: 'nat',
    title: 'Natación',
    date: '2026-09-03',
    startTime: '17:30',
    reminderMins: 30,
    recurrence: { freq: 'weekly', interval: 1 },
  }),
  ev({ id: 'sc', title: 'Día sin cole', date: '2026-10-22', reminderMins: 0 }),
  ev({ id: 'ab', title: 'Abuelos en casa', date: '2026-10-20', endDate: '2026-10-24' }),
  ev({ id: 'cena', title: 'Cena con amigos', date: '2026-10-22', startTime: '21:00' }),
  ev({ id: 'med', title: 'Médico', date: '2026-10-22', startTime: '09:15' }),
  ev({ id: 'man', title: 'Mañana no', date: '2026-10-23', startTime: '09:00' }),
];
const menu: MenuDay = { id: '2026-10-22', lunch: 'Lentejas', dinner: 'Tortilla de patatas' };
const task = (t: Partial<Task> & Pick<Task, 'id' | 'title'>): Task => ({
  memberIds: [],
  done: false,
  createdAt: 0,
  ...t,
});
const tasks: Task[] = [
  task({ id: 't1', title: 'Sacar la basura', due: '2026-10-22' }),
  task({ id: 't2', title: 'Pagar comedor', due: '2026-10-20' }),
  task({ id: 't3', title: 'Regar plantas', due: '2026-10-23' }),
  task({ id: 't4', title: 'Hecha', due: '2026-10-21', done: true }),
  task({ id: 't5', title: 'Sin fecha', due: null }),
];
const noaBirthday: KeyDate = {
  id: 'bnoa',
  title: 'Noa',
  kind: 'birthday',
  date: '2022-10-22',
  repeat: 'yearly',
  remindDays: 0,
};
const dailyIn = { events: dayEvents, tasks, menuToday: menu, keyDates: [noaBirthday] };

test('daily summary', () => {
  const r = run({ ...dailyIn, now: Z('2026-10-22T06:05:00Z') });
  const d = ofKind(r.messages, 'daily');
  assert.deepEqual(
    d.map((m) => [m.key, m.toUids, m.tag]),
    [
      ['daily_2026-10-22_u1', ['u1'], 'daily_2026-10-22'],
      ['daily_2026-10-22_u2', ['u2'], 'daily_2026-10-22'],
    ],
    'one per person, the same tag',
  );
  assert.equal(d[0]?.title, 'Buenos días · jueves 22');
  assert.equal(d[0]?.url, '/#/');
  assert.equal(
    d[0]?.body,
    [
      'Todo el día · Abuelos en casa',
      'Todo el día · Día sin cole',
      '9:15 · Médico',
      '17:30 · Natación',
      '21:00 · Cena con amigos',
      '🍽️ Comida: Lentejas · Cena: Tortilla de patatas',
      '✅ 2 tareas (1 atrasada): Pagar comedor y Sacar la basura',
      '🎂 Cumpleaños de Noa (4 años)',
    ].join('\n'),
  );
  // No key date notifications before 9 (the birthday is in the summary).
  assert.equal(ofKind(r.messages, 'keydate').length, 0);
  // Kept until the end of its window (11:00 = 09:00Z)
  assert.equal(
    compute({ ...dailyIn, now: Z('2026-10-22T06:05:00Z') }).messages.find((m) => m.kind === 'daily')?.ttl,
    175 * 60,
  );
});

test('daily summary: time window and settings', () => {
  const n = (now: string, over: Partial<ComputeInput> = {}) =>
    ofKind(run({ ...dailyIn, now: Z(now), ...over }).messages, 'daily').filter((m) => m.toUids.includes('u1')).length;
  assert.equal(n('2026-10-22T05:59:00Z'), 0); // 07:59
  assert.equal(n('2026-10-22T06:00:00Z'), 1); // 08:00
  assert.equal(n('2026-10-22T08:59:00Z'), 1); // 10:59
  assert.equal(n('2026-10-22T09:00:00Z'), 0); // 11:00
  assert.equal(
    n('2026-10-22T06:30:00Z', { household: { ...H, notify: { dailySummary: false, dailyHour: 8, activity: true } } }),
    0,
  );
  // Custom hour
  const late = { ...H, notify: { dailySummary: true, dailyHour: 20, activity: true } };
  assert.equal(n('2026-10-22T06:30:00Z', { household: late }), 0);
  const r = run({ ...dailyIn, household: late, now: Z('2026-10-22T18:30:00Z') });
  assert.equal(ofKind(r.messages, 'daily')[0]?.title, 'Buenas noches · jueves 22');
  // Menu only
  const onlyMenu = run({ now: Z('2026-10-22T06:30:00Z'), menuToday: { id: '2026-10-22', dinner: 'Pizza' } });
  assert.equal(ofKind(onlyMenu.messages, 'daily')[0]?.body, '🍽️ Cena: Pizza');
  // A single overdue task
  const one = run({
    now: Z('2026-10-22T06:30:00Z'),
    tasks: [task({ id: 'x', title: 'Llamar al fontanero', due: '2026-10-19' })],
  });
  assert.equal(ofKind(one.messages, 'daily')[0]?.body, '✅ Tarea: Llamar al fontanero (atrasada)');
});

test('daily summary with nothing to say: no message, but done for today', () => {
  const r = compute({ now: Z('2026-10-22T06:30:00Z') });
  assert.equal(r.messages.length, 0);
  assert.deepEqual(r.quietKeys, ['daily_2026-10-22_u1', 'daily_2026-10-22_u2']);
  // Before the window nothing is done yet; after it, it's over for today
  assert.deepEqual(compute({ now: Z('2026-10-22T05:00:00Z') }).quietKeys, []);
  assert.deepEqual(compute({ now: Z('2026-10-22T12:00:00Z') }).quietKeys, [
    'daily_2026-10-22_u1',
    'daily_2026-10-22_u2',
  ]);
  assert.deepEqual(compute({ ...dailyIn, now: Z('2026-10-22T06:30:00Z') }).quietKeys, []);
});

test('daily summary on a DST change day', () => {
  // 2026-10-25: 08:05 CET is 07:05Z
  const misa = [ev({ id: 'x', title: 'Misa', date: '2026-10-25', startTime: '12:00' })];
  assert.equal(
    ofKind(run({ now: Z('2026-10-25T07:05:00Z'), events: misa }).messages, 'daily')[0]?.title,
    'Buenos días · domingo 25',
  );
  assert.equal(ofKind(run({ now: Z('2026-10-25T06:59:00Z'), events: misa }).messages, 'daily').length, 0);
});

// =====================================================================
// Key dates
// =====================================================================

const itv: KeyDate = {
  id: 'itv',
  title: 'ITV coche',
  kind: 'car',
  date: '2026-10-29',
  repeat: 'none',
  remindDays: 7,
  amount: 4590,
};
const bday: KeyDate = {
  id: 'blia',
  title: 'Lía',
  kind: 'birthday',
  date: '2020-10-29',
  repeat: 'yearly',
  remindDays: 7,
};
const rent: KeyDate = {
  id: 'alq',
  title: 'Alquiler',
  kind: 'bill',
  date: '2026-01-31',
  repeat: 'monthly',
  remindDays: 2,
  amount: 85000,
};
const leap: KeyDate = {
  id: 'leo',
  title: 'Leo',
  kind: 'birthday',
  date: '2016-02-29',
  repeat: 'yearly',
  remindDays: 0,
};

const kdRun = (keyDates: KeyDate[], now: string, lang: Lang = 'es') =>
  ofKind(run({ keyDates, now: Z(now) }, lang).messages, 'keydate');

test('key date: car inspection (ITV) with amount', () => {
  assert.equal(kdRun([itv], '2026-10-22T06:50:00Z').length, 0); // 08:50: not yet
  const [m] = kdRun([itv], '2026-10-22T07:10:00Z'); // 09:10
  assert.equal(m?.key, 'kd_itv_2026-10-29_7');
  assert.equal(m?.title, '🚗 ITV coche');
  assert.equal(nb(m?.body ?? ''), 'Vence en 7 días (jue 29 oct) · 45,90 €');
  assert.equal(m?.url, '/#/dates');
  assert.equal(kdRun([itv], '2026-10-23T07:10:00Z').length, 0); // 6 days left
  const [today] = kdRun([itv], '2026-10-29T08:30:00Z'); // 09:30 CET
  assert.equal(today?.key, 'kd_itv_2026-10-29_0');
  assert.equal(nb(today?.body ?? ''), 'Vence hoy · 45,90 €');
  assert.equal(kdRun([itv], '2026-10-30T08:30:00Z').length, 0); // already passed
  assert.equal(nb(kdRun([{ ...itv, remindDays: 1 }], '2026-10-28T08:30:00Z')[0]?.body ?? ''), 'Vence mañana · 45,90 €');
  // Kept until the end of the day (24:00 CET = 23:00Z)
  const [c] = compute({ keyDates: [itv], now: Z('2026-10-29T08:30:00Z') }).messages;
  assert.equal(c?.ttl, 14.5 * 3600);
});

test('key date: birthday', () => {
  const [m] = kdRun([bday], '2026-10-22T07:10:00Z');
  assert.equal(m?.title, '🎂 Cumpleaños de Lía');
  assert.equal(m?.body, 'Cumple 6 años en 7 días (jue 29 oct)');
  const [d] = kdRun([bday], '2026-10-29T08:00:00Z');
  assert.equal(d?.key, 'kd_blia_2026-10-29_0');
  assert.equal(d?.body, '¡Hoy cumple 6 años!');
  assert.equal(kdRun([{ ...bday, remindDays: 1 }], '2026-10-28T08:00:00Z')[0]?.body, 'Mañana cumple 6 años');
  assert.equal(kdRun([{ ...bday, date: '2025-10-29' }], '2026-10-29T08:00:00Z')[0]?.body, '¡Hoy cumple 1 año!');
  // title that already says "Cumple…", wrongly stored repeat and no credible year
  const abu: KeyDate = {
    id: 'abu',
    title: 'Cumple de la abuela',
    kind: 'birthday',
    date: '0001-11-02',
    repeat: 'none',
    remindDays: 0,
  };
  const [a] = kdRun([abu], '2026-11-02T09:00:00Z');
  assert.equal(a?.title, '🎂 Cumple de la abuela');
  assert.equal(a?.body, '¡Hoy es su cumpleaños!');
});

test('key date: 29 February', () => {
  const [m] = kdRun([leap], '2027-02-28T09:00:00Z');
  assert.equal(m?.key, 'kd_leo_2027-02-28_0');
  assert.equal(m?.body, '¡Hoy cumple 11 años!');
  assert.equal(kdRun([leap], '2028-02-28T09:00:00Z').length, 0);
  assert.equal(kdRun([leap], '2028-02-29T09:00:00Z')[0]?.body, '¡Hoy cumple 12 años!');
});

test('key date: monthly bill on the 31st', () => {
  const [oct] = kdRun([rent], '2026-10-29T08:30:00Z');
  assert.equal(oct?.key, 'kd_alq_2026-10-31_2');
  assert.equal(oct?.title, '🧾 Alquiler');
  assert.equal(nb(oct?.body ?? ''), 'Vence en 2 días (sáb 31 oct) · 850,00 €');
  const [nov] = kdRun([rent], '2026-11-28T08:30:00Z');
  assert.equal(nov?.key, 'kd_alq_2026-11-30_2');
  assert.equal(nb(nov?.body ?? ''), 'Vence en 2 días (lun 30 nov) · 850,00 €');
  assert.equal(kdRun([rent], '2026-11-29T08:30:00Z').length, 0);
  const [day] = kdRun([rent], '2026-11-30T08:30:00Z');
  assert.equal(day?.key, 'kd_alq_2026-11-30_0');
  assert.equal(nb(day?.body ?? ''), 'Vence hoy · 850,00 €');
  const [feb] = kdRun([rent], '2027-02-26T08:30:00Z');
  assert.equal(feb?.key, 'kd_alq_2027-02-28_2');
  assert.equal(nb(feb?.body ?? ''), 'Vence en 2 días (dom 28 feb) · 850,00 €');
  // In the daily summary
  const r = run({ keyDates: [rent], now: Z('2026-11-30T07:30:00Z') });
  assert.equal(nb(ofKind(r.messages, 'daily')[0]?.body ?? ''), '🧾 Alquiler · vence hoy · 850,00 €');
});

test('key date: other kinds, remindDays 0 and year change', () => {
  const vac: KeyDate = {
    id: 'vac',
    title: 'Vacuna gripe',
    kind: 'health',
    date: '2026-10-24',
    repeat: 'none',
    remindDays: 2,
  };
  assert.equal(kdRun([vac], '2026-10-22T07:10:00Z')[0]?.body, 'En 2 días (sáb 24 oct)');
  assert.equal(kdRun([vac], '2026-10-22T07:10:00Z')[0]?.title, '🩺 Vacuna gripe');
  assert.equal(kdRun([{ ...vac, remindDays: 0 }], '2026-10-24T07:10:00Z').length, 1);
  const ny: KeyDate = {
    id: 'seg',
    title: 'Seguro hogar',
    kind: 'insurance',
    date: '2021-01-03',
    repeat: 'yearly',
    remindDays: 7,
  };
  assert.equal(kdRun([ny], '2026-12-27T09:00:00Z')[0]?.body, 'Vence en 7 días (dom 3 ene 2027)');
});

// =====================================================================
// Activity
// =====================================================================

const NOW = Z('2026-10-22T10:00:00Z');
const act = (
  id: string,
  actorUid: string,
  actorName: string,
  kind: Activity['kind'],
  text: string,
  minsAgo: number,
  notified = false,
): Activity => ({ id, actorUid, actorName, kind, text, createdAt: NOW - minsAgo * 60_000, notified });
const activity: Activity[] = [
  act('a1', 'u1', 'Alex', 'shopping', 'leche', 20),
  act('a2', 'u1', 'Alex', 'shopping', 'pan', 19),
  act('a3', 'u1', 'Alex', 'shopping', 'huevos', 18),
  act('a4', 'u2', 'Sam', 'event', 'Dentista', 15),
  act('a5', 'u2', 'Sam', 'task', 'Comprar regalo', 10),
  act('a6', 'u2', 'Sam', 'menu', '', 5),
  act('a7', 'u1', 'Alex', 'shopping', 'Leche', 17),
  act('a8', 'u1', 'Alex', 'shopping', 'viejo', 30, true),
  act('a9', 'u1', 'Alex', 'shopping', 'yogures', 13 * 60),
];

test('activity digest per person', () => {
  const r = run({ activity, now: NOW });
  const ms = ofKind(r.messages, 'activity');
  assert.equal(ms.length, 2);
  const alex = ms.find((m) => m.title === 'Alex');
  assert.equal(alex?.body, 'Ha añadido a la compra: leche, pan y huevos');
  assert.equal(alex?.url, '/#/shopping');
  assert.deepEqual(alex?.toUids, ['u2']);
  assert.equal(alex?.key, undefined);
  const sam = ms.find((m) => m.title === 'Sam');
  assert.equal(sam?.body, 'Nuevo evento: Dentista\nNueva tarea: Comprar regalo\nMenú actualizado');
  assert.equal(sam?.url, '/#/calendar');
  assert.deepEqual(sam?.toUids, ['u1']);
  assert.deepEqual([...r.activityIdsToMark].sort(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a9']);
});

test('activity: dominant kind, many items and settings', () => {
  const r = run({
    now: NOW,
    activity: [
      act('b1', 'u2', 'Sam', 'event', 'Cine', 3),
      act('b2', 'u2', 'Sam', 'task', 'Poner lavadora', 2),
      act('b3', 'u2', 'Sam', 'task', 'Ir al banco', 1),
      act('b4', 'u2', 'Sam', 'expense', 'Supermercado', 1),
      act('b5', 'u2', 'Sam', 'date', 'ITV coche', 1),
      act('b6', 'u2', 'Sam', 'note', 'Claves wifi', 1),
    ],
  });
  const [m] = ofKind(r.messages, 'activity');
  assert.equal(m?.url, '/#/tasks');
  assert.equal(
    m?.body,
    'Nuevas tareas: Poner lavadora e Ir al banco\nNuevo evento: Cine\nNueva fecha: ITV coche\nNuevo gasto: Supermercado\nNueva nota: Claves wifi',
  );
  const many = Array.from({ length: 10 }, (_, i) => act(`c${i}`, 'u1', 'Alex', 'shopping', `cosa ${i + 1}`, 10 - i));
  assert.equal(
    ofKind(run({ now: NOW, activity: many }).messages, 'activity')[0]?.body,
    'Ha añadido a la compra: cosa 1, cosa 2, cosa 3, cosa 4, cosa 5, cosa 6, cosa 7, cosa 8 y 2 más',
  );
  const off = run({
    now: NOW,
    activity,
    household: { ...H, notify: { dailySummary: true, dailyHour: 8, activity: false } },
  });
  assert.equal(ofKind(off.messages, 'activity').length, 0);
  assert.equal(off.activityIdsToMark.length, 8); // marked anyway
});

test("activity: the actor's name comes from the household, not from the document", () => {
  const spoofed = [act('s1', 'u2', 'Banco: verifica tu cuenta en evil.example', 'note', 'Wifi', 1)];
  assert.equal(ofKind(run({ now: NOW, activity: spoofed }).messages, 'activity')[0]?.title, 'Sam');
  // An account not linked to a member yet: its own name, clipped
  const newcomer = [act('n1', 'u9', `Noa ${'x'.repeat(100)}`, 'note', 'Wifi', 1)];
  const [m] = ofKind(run({ now: NOW, activity: newcomer }).messages, 'activity');
  assert.equal(Array.from(m?.title ?? '').length, 40);
  assert.ok(m?.title.startsWith('Noa '));
  // Long items are clipped one by one
  const long = [act('l1', 'u1', 'Alex', 'shopping', 'y'.repeat(300), 1), act('l2', 'u1', 'Alex', 'shopping', 'pan', 1)];
  const body = ofKind(run({ now: NOW, activity: long }).messages, 'activity')[0]?.body ?? '';
  assert.match(body, /^Ha añadido a la compra: y{79}… y pan$/);
});

test('activity digest: whole burst on request, tag of its first item, kept for an hour', () => {
  const burst = [act('x1', 'u1', 'Alex', 'shopping', 'leche', 3, true), act('x2', 'u1', 'Alex', 'shopping', 'pan', 1)];
  const [m] = activityDigest(burst, NOW, people(H), { includeNotified: true, members: H.members });
  assert.equal(m?.render('es').body, 'Ha añadido a la compra: leche y pan');
  assert.equal(m?.tag, `act_u1_${NOW - 3 * 60_000}`);
  assert.equal(m?.ttl, 3600);
  assert.equal(activityDigest(burst, NOW, people(H))[0]?.render('es').body, 'Ha añadido a la compra: pan');
});

test('all together: several things in one run', () => {
  const r = run({
    events: [...dayEvents, dentista],
    tasks,
    menuToday: menu,
    keyDates: [noaBirthday, itv, bday],
    activity,
    now: Z('2026-10-22T07:05:00Z'),
  });
  // 09:05: reminder for "Día sin cole" (09:00), key dates (Noa today; ITV and Lía's birthday in
  // 7 days), daily summary and activity.
  assert.deepEqual(
    r.messages.map((m) => m.key ?? m.kind),
    [
      'ev_sc_2026-10-22_0',
      'kd_bnoa_2026-10-22_0',
      'kd_itv_2026-10-29_7',
      'kd_blia_2026-10-29_7',
      'daily_2026-10-22_u1',
      'daily_2026-10-22_u2',
      'activity',
      'activity',
    ],
  );
});

// =====================================================================
// English ('en' devices)
// =====================================================================

test('en: event reminders', () => {
  const r = run({ events: [dentista], now: Z('2026-10-22T14:05:00Z') }, 'en');
  assert.deepEqual(r.messages, [
    {
      key: 'ev_dent_2026-10-22_60',
      kind: 'reminder',
      title: 'Dentista',
      body: 'Today at 17:00 · Lía and Noa · Clínica Sonrisas',
      url: '/#/calendar',
      tag: 'ev_dent_2026-10-22',
      urgency: 'high',
      toUids: ['u1', 'u2'],
    },
  ]);
  const body = (e: CalEvent, now: string) =>
    ofKind(run({ events: [e], now: Z(now) }, 'en').messages, 'reminder')[0]?.body;
  assert.equal(
    body(
      ev({ id: 'rev', title: 'R', date: '2026-10-23', startTime: '10:00', reminderMins: 1440 }),
      '2026-10-22T08:05:00Z',
    ),
    'Tomorrow at 10:00',
  );
  assert.equal(
    body(
      ev({ id: 'exc', title: 'Trip', date: '2026-10-23', reminderMins: 780, memberIds: ['lia', 'iker'] }),
      '2026-10-22T18:05:00Z',
    ),
    'Tomorrow, all day · Lía and Iker',
  );
  assert.equal(
    body(
      ev({ id: 'vac', title: 'Holidays', date: '2026-10-24', endDate: '2026-10-27', reminderMins: 780 }),
      '2026-10-23T18:05:00Z',
    ),
    'Tomorrow, all day (until Tuesday 27)',
  );
  const untitled = run({ events: [{ ...dentista, title: '  ' }], now: Z('2026-10-22T14:05:00Z') }, 'en');
  assert.equal(untitled.messages[0]?.title, 'Event');
});

test('en: daily summary', () => {
  const r = run({ ...dailyIn, now: Z('2026-10-22T06:05:00Z') }, 'en');
  const [d] = ofKind(r.messages, 'daily');
  assert.equal(d?.key, 'daily_2026-10-22_u1');
  assert.equal(d?.title, 'Good morning · Thursday 22');
  assert.equal(d?.url, '/#/');
  assert.equal(
    d?.body,
    [
      'All day · Abuelos en casa',
      'All day · Día sin cole',
      '9:15 · Médico',
      '17:30 · Natación',
      '21:00 · Cena con amigos',
      '🍽️ Lunch: Lentejas · Dinner: Tortilla de patatas',
      '✅ 2 tasks (1 overdue): Pagar comedor and Sacar la basura',
      "🎂 Noa's birthday (turns 4)",
    ].join('\n'),
  );
  const late = { ...H, notify: { dailySummary: true, dailyHour: 20, activity: true } };
  assert.equal(
    ofKind(run({ ...dailyIn, household: late, now: Z('2026-10-22T18:30:00Z') }, 'en').messages, 'daily')[0]?.title,
    'Good evening · Thursday 22',
  );
  const one = run(
    { now: Z('2026-10-22T06:30:00Z'), tasks: [task({ id: 'x', title: 'Call the plumber', due: '2026-10-19' })] },
    'en',
  );
  assert.equal(ofKind(one.messages, 'daily')[0]?.body, '✅ Task: Call the plumber (overdue)');
  const rentDay = run({ keyDates: [rent], now: Z('2026-11-30T07:30:00Z') }, 'en');
  assert.equal(ofKind(rentDay.messages, 'daily')[0]?.body, '🧾 Alquiler · due today · €850.00');
  // More than 6 events today
  const lots = Array.from({ length: 8 }, (_, i) =>
    ev({ id: `l${i}`, title: `E${i}`, date: '2026-10-22', startTime: `1${i}:00` }),
  );
  const body = (lang: Lang) =>
    (ofKind(run({ events: lots, now: Z('2026-10-22T06:30:00Z') }, lang).messages, 'daily')[0]?.body ?? '').split('\n');
  assert.equal(body('en').length, 7);
  assert.equal(body('en')[6], 'and 2 more events');
  assert.equal(body('es')[6], 'y 2 eventos más');
});

test('en: key dates (birthday with age, amounts, other kinds)', () => {
  const kd = (keyDates: KeyDate[], now: string) => kdRun(keyDates, now, 'en');
  const [b] = kd([bday], '2026-10-22T07:10:00Z');
  assert.equal(b?.key, 'kd_blia_2026-10-29_7');
  assert.equal(b?.title, "🎂 Lía's birthday");
  assert.equal(b?.body, 'Turns 6 in 7 days (Thu 29 Oct)');
  assert.equal(b?.url, '/#/dates');
  assert.equal(kd([bday], '2026-10-29T08:00:00Z')[0]?.body, 'Turns 6 today!');
  assert.equal(kd([{ ...bday, remindDays: 1 }], '2026-10-28T08:00:00Z')[0]?.body, 'Turns 6 tomorrow');
  const abu: KeyDate = {
    id: 'abu',
    title: 'Cumple de la abuela',
    kind: 'birthday',
    date: '0001-11-02',
    repeat: 'none',
    remindDays: 0,
  };
  const [a] = kd([abu], '2026-11-02T09:00:00Z');
  assert.equal(a?.title, '🎂 Cumple de la abuela');
  assert.equal(a?.body, "It's their birthday today!");
  assert.equal(
    kd([{ ...abu, title: "Grandma's birthday" }], '2026-11-02T09:00:00Z')[0]?.title,
    "🎂 Grandma's birthday",
  );
  assert.equal(kd([{ ...abu, title: '' }], '2026-11-02T09:00:00Z')[0]?.title, '🎂 Birthday');
  assert.equal(kdRun([{ ...abu, title: '' }], '2026-11-02T09:00:00Z')[0]?.title, '🎂 Cumpleaños');

  const [i] = kd([itv], '2026-10-22T07:10:00Z');
  assert.equal(i?.key, 'kd_itv_2026-10-29_7');
  assert.equal(i?.title, '🚗 ITV coche');
  assert.equal(i?.body, 'Due in 7 days (Thu 29 Oct) · €45.90');
  assert.equal(kd([itv], '2026-10-29T08:30:00Z')[0]?.body, 'Due today · €45.90');
  assert.equal(kd([{ ...itv, remindDays: 1 }], '2026-10-28T08:30:00Z')[0]?.body, 'Due tomorrow · €45.90');
  assert.equal(kd([rent], '2026-10-29T08:30:00Z')[0]?.body, 'Due in 2 days (Sat 31 Oct) · €850.00');

  const vac: KeyDate = {
    id: 'vac',
    title: 'Flu jab',
    kind: 'health',
    date: '2026-10-24',
    repeat: 'none',
    remindDays: 2,
  };
  assert.equal(kd([vac], '2026-10-22T07:10:00Z')[0]?.body, 'In 2 days (Sat 24 Oct)');
  const ny: KeyDate = {
    id: 'seg',
    title: 'Home insurance',
    kind: 'insurance',
    date: '2021-01-03',
    repeat: 'yearly',
    remindDays: 7,
  };
  assert.equal(kd([ny], '2026-12-27T09:00:00Z')[0]?.body, 'Due in 7 days (Sun 3 Jan 2027)');
});

test('en: activity digest', () => {
  const r = run({ activity, now: NOW }, 'en');
  const ms = ofKind(r.messages, 'activity');
  const alex = ms.find((m) => m.title === 'Alex');
  assert.equal(alex?.body, 'Added to the shopping list: leche, pan and huevos');
  assert.equal(alex?.url, '/#/shopping');
  assert.deepEqual(alex?.toUids, ['u2']);
  const sam = ms.find((m) => m.title === 'Sam');
  assert.equal(sam?.body, 'New event: Dentista\nNew task: Comprar regalo\nUpdated the menu');
  assert.equal(sam?.url, '/#/calendar');
  const mixed = run(
    {
      now: NOW,
      activity: [
        act('b1', 'u2', 'Sam', 'event', 'Cinema', 3),
        act('b2', 'u2', 'Sam', 'task', 'Laundry', 2),
        act('b3', 'u2', 'Sam', 'task', 'Go to the bank', 1),
        act('b4', 'u2', 'Sam', 'expense', 'Groceries', 1),
        act('b5', 'u2', 'Sam', 'date', 'MOT', 1),
        act('b6', 'u2', 'Sam', 'note', 'Wifi password', 1),
        act('b7', 'u2', 'Sam', 'shopping', '', 1),
      ],
    },
    'en',
  );
  assert.equal(
    ofKind(mixed.messages, 'activity')[0]?.body,
    'New tasks: Laundry and Go to the bank\nUpdated the shopping list\nNew event: Cinema\nNew key date: MOT\n' +
      'New expense: Groceries\nNew note: Wifi password',
  );
  const many = Array.from({ length: 10 }, (_, k) => act(`c${k}`, 'u1', 'Alex', 'shopping', `thing ${k + 1}`, 10 - k));
  assert.equal(
    ofKind(run({ now: NOW, activity: many }, 'en').messages, 'activity')[0]?.body,
    'Added to the shopping list: thing 1, thing 2, thing 3, thing 4, thing 5, thing 6, thing 7, thing 8 and 2 more',
  );
  const anon = run({ now: NOW, activity: [act('z', '', ' ', 'note', 'Wifi', 1)] }, 'en');
  assert.equal(ofKind(anon.messages, 'activity')[0]?.title, 'Someone at home');
  assert.deepEqual(ofKind(anon.messages, 'activity')[0]?.toUids, ['u1', 'u2']);
});

test('each message renders in every language, the rest is shared', () => {
  const r = compute({
    events: [...dayEvents, dentista],
    tasks,
    menuToday: menu,
    keyDates: [noaBirthday, itv, bday],
    activity,
    now: Z('2026-10-22T07:05:00Z'),
  });
  for (const m of r.messages) {
    const es = m.render('es');
    const en = m.render('en');
    assert.ok(es.title && en.title && es.body && en.body, m.tag);
  }
  assert.notEqual(r.messages[0]?.render('en').body, r.messages[0]?.render('es').body);
});

// =====================================================================
// Each person's choices
// =====================================================================

test('activity: each person only gets the kinds they chose, a mixed burst is filtered per person', () => {
  const trio = { ...H, memberUids: ['u1', 'u2', 'u3'] };
  const recipients = people(trio, {
    u2: { activity: { event: false } }, // everything but events
    u3: {
      activity: { shopping: false, event: false, task: false, menu: false, expense: false, date: false, note: false },
    },
  });
  const burst = [
    act('m1', 'u1', 'Alex', 'shopping', 'leche', 3),
    act('m2', 'u1', 'Alex', 'event', 'Cine', 2),
    act('m3', 'u1', 'Alex', 'shopping', 'pan', 1),
  ];
  const ms = activityDigest(burst, NOW, recipients, { members: H.members });
  assert.equal(ms.length, 1, 'u3 wants nothing, the actor never gets their own');
  assert.deepEqual(ms[0]?.toUids, ['u2']);
  assert.equal(ms[0]?.render('es').body, 'Ha añadido a la compra: leche y pan');

  // Different choices ⇒ different messages, the same tag (a newer digest replaces the older one)
  const split = activityDigest(burst, NOW, people(trio, { u3: { activity: { shopping: false } } }));
  assert.deepEqual(
    split.map((m) => [m.toUids, m.url, m.render('en').body]),
    [
      [['u2'], '/#/shopping', 'Added to the shopping list: leche and pan\nNew event: Cine'],
      [['u3'], '/#/calendar', 'New event: Cine'],
    ],
  );
  assert.equal(split[0]?.tag, split[1]?.tag);
});

test('activity: the actor never gets their own, whatever they chose', () => {
  const ms = activityDigest([act('x', 'u1', 'Alex', 'note', 'Wifi', 1)], NOW, people(H));
  assert.deepEqual(ms[0]?.toUids, ['u2']);
  const alone = { ...H, memberUids: ['u1'] };
  assert.deepEqual(activityDigest([act('x', 'u1', 'Alex', 'note', 'Wifi', 1)], NOW, people(alone)), []);
});

test('reminders and key dates only to the people who want them', () => {
  const now = Z('2026-10-22T14:05:00Z');
  const rem = (prefs: Record<string, PersonalNotify>) =>
    compute({ events: [dentista], now, recipients: people(H, prefs) }).messages.map((m) => m.toUids);
  assert.deepEqual(rem({ u2: { reminders: false } }), [['u1']]);
  assert.deepEqual(rem({ u1: { reminders: false }, u2: { reminders: false } }), [], 'nobody: no message');

  const kd = (prefs: Record<string, PersonalNotify>) =>
    compute({ keyDates: [itv], now: Z('2026-10-22T07:10:00Z'), recipients: people(H, prefs) })
      .messages.filter((m) => m.kind === 'keydate')
      .map((m) => m.toUids);
  assert.deepEqual(kd({ u1: { keyDates: false } }), [['u2']]);
  assert.deepEqual(kd({ u1: { keyDates: false }, u2: { keyDates: false } }), []);
});

test('morning summary: each person at their own hour, nothing for those who turned it off', () => {
  const recipients = people(H, { u1: { dailyHour: 7 }, u2: { dailyHour: 9 } });
  const at = (iso: string, r: Recipients = recipients) =>
    compute({ ...dailyIn, now: Z(iso), recipients: r }).messages.filter((m) => m.kind === 'daily');
  assert.deepEqual(
    at('2026-10-22T05:30:00Z').map((m) => m.key),
    ['daily_2026-10-22_u1'],
  ); // 07:30
  assert.deepEqual(
    at('2026-10-22T07:30:00Z').map((m) => m.key),
    ['daily_2026-10-22_u1', 'daily_2026-10-22_u2'],
  ); // 09:30: both windows open (the caller drops what was sent)
  assert.deepEqual(
    at('2026-10-22T08:05:00Z').map((m) => m.key),
    ['daily_2026-10-22_u2'],
  ); // 10:05: u1's is over
  assert.equal(at('2026-10-22T05:30:00Z')[0]?.render('es').title, 'Buenos días · jueves 22');
  // Kept until the end of each one's window
  assert.equal(at('2026-10-22T05:30:00Z')[0]?.ttl, 150 * 60); // until 10:00 = 08:00Z

  const off = people(H, { u2: { daily: false } });
  const r = compute({ ...dailyIn, now: Z('2026-10-22T06:30:00Z'), recipients: off });
  assert.deepEqual(
    r.messages.filter((m) => m.kind === 'daily').map((m) => m.key),
    ['daily_2026-10-22_u1'],
  );
  assert.deepEqual(r.quietKeys, ['daily_2026-10-22_u2'], 'turned off: done for today');
  assert.deepEqual(openDailyUids(recipients, 8), ['u1']);
  assert.deepEqual(openDailyUids(recipients, 9), ['u1', 'u2']);
});

test('morning summary: members without a device are done for today', () => {
  const onlyU1: Recipients = new Map([['u1', resolveNotify(H, null)]]);
  const r = compute({ ...dailyIn, now: Z('2026-10-22T06:30:00Z'), recipients: onlyU1 });
  assert.deepEqual(
    r.messages.filter((m) => m.kind === 'daily').map((m) => m.toUids),
    [['u1']],
  );
  assert.deepEqual(r.quietKeys, ['daily_2026-10-22_u2']);
});

test("everyone(): what may be due before reading anyone's choices", () => {
  const old = { ...H, notify: { dailySummary: true, dailyHour: 8, activity: false } };
  const r = computeNotifications({
    household: old,
    recipients: everyone(old),
    events: [dentista],
    tasks: [],
    menuToday: menu,
    keyDates: [],
    activity: [act('a', 'u1', 'Alex', 'shopping', 'leche', 1)],
    now: Z('2026-10-22T14:05:00Z'),
  });
  // Activity counts even though the household default is off (someone may have turned it on);
  // the morning summary is left out (it depends on each person's hour).
  assert.deepEqual(
    r.messages.map((m) => m.kind),
    ['reminder', 'activity'],
  );
});
