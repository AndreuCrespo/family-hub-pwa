// Tests of run.ts (reading, delivery and state) with an in-memory Firestore.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import webpush from 'web-push';
import { zonedToUtc } from '../../src/shared/dates';
import { FakeFirestore } from './fake-firestore';
import { log } from './log';
import { processActivity, processAllHouseholds } from './run';
import { writer } from './store';

interface Sent {
  endpoint: string;
  payload: { title: string; body: string; url: string; tag: string };
  ttl: number;
}
let sent: Sent[] = [];
/** endpoint → HTTP status the fake push service answers with. */
let failures = new Map<string, number>();
let logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];

// Replaces real delivery with one that records what would have been sent.
(webpush as unknown as { sendNotification: unknown }).sendNotification = async (
  sub: { endpoint: string },
  payload: string,
  opts: { TTL: number },
) => {
  const status = failures.get(sub.endpoint);
  if (status) throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
  sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), ttl: opts.TTL });
  return {};
};
for (const level of ['info', 'warn', 'error'] as const) {
  log[level] = (message, fields) => void logs.push({ level, message, fields });
}

const HID = 'h1';
const H = `households/${HID}`;
const TZ = 'Europe/Madrid';
const EP_A = 'https://fcm.googleapis.com/fcm/send/A';
const EP_B = 'https://updates.push.services.mozilla.com/wpush/v2/B';
const MIN = 60_000;

const sub = (ep: string) => ({ endpoint: ep, keys: { p256dh: 'p', auth: 'a' } });
function seedHousehold(db: FakeFirestore, path = H) {
  db.seed(path, {
    name: 'Casa',
    timezone: TZ,
    memberUids: ['uA', 'uB'],
    members: [
      { id: 'a', name: 'Alex', color: '#000', kind: 'adult', uid: 'uA' },
      { id: 'b', name: 'Sam', color: '#000', kind: 'adult', uid: 'uB' },
      { id: 'k', name: 'Lía', color: '#000', kind: 'child' },
    ],
    notify: { dailySummary: true, dailyHour: 8, activity: true },
  });
  db.seed(`${path}/devices/dA`, { uid: 'uA', subscription: sub(EP_A), ua: '', createdAt: 0 });
  db.seed(`${path}/devices/dB`, { uid: 'uB', subscription: sub(EP_B), ua: '', createdAt: 0 });
}
const dentist = {
  title: 'Dentista',
  date: '2026-10-22',
  startTime: '17:00',
  endTime: '18:00',
  memberIds: ['k'],
  reminderMins: 60,
  recurrence: null,
  exdates: [],
  location: 'Clínica',
};
const FIRE = zonedToUtc('2026-10-22', '16:00', TZ);

const asDb = (db: FakeFirestore) => db as unknown as Firestore;
const href = (db: FakeFirestore, hid = HID) => asDb(db).collection('households').doc(hid);
const to = (endpoint: string) => sent.find((s) => s.endpoint === endpoint)?.payload;
const meta = (db: FakeFirestore, path = H) =>
  db.get(`${path}/meta/notifier`) as
    | { sent: Record<string, number>; keyDatesOn: string | null; cleanedOn: string | null }
    | undefined;
/** Recorded keys: the morning summaries' or the rest. */
const sentKeys = (db: FakeFirestore, which: 'daily' | 'other' = 'other') =>
  Object.keys(meta(db)?.sent ?? {})
    .filter((k) => k.startsWith('daily_') === (which === 'daily'))
    .sort();
const instant = (db: FakeFirestore, id: string, debounceMs = 0, createTime = Date.now()) =>
  processActivity(asDb(db), href(db), id, { createTime, debounceMs });

beforeEach(() => {
  sent = [];
  failures = new Map();
  logs = [];
});

// =====================================================================
// Scheduled job
// =====================================================================

test('scheduled: an event reminder is sent once and its key recorded', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.seed(`${H}/events/dent`, dentist);

  await processAllHouseholds(asDb(db), FIRE + MIN);
  assert.equal(sent.length, 2, 'to both phones');
  assert.equal(sent[0]?.payload.title, 'Dentista');
  assert.match(sent[0]?.payload.body ?? '', /17:00/);
  assert.equal(sent[0]?.ttl, 69 * 60, 'kept until 10 minutes after the start');
  assert.deepEqual(sentKeys(db), ['ev_dent_2026-10-22_60']);

  // The next runs don't repeat it
  sent = [];
  await processAllHouseholds(asDb(db), FIRE + 6 * MIN);
  await processAllHouseholds(asDb(db), FIRE + 11 * MIN);
  assert.equal(sent.length, 0);
});

test('scheduled: each device gets its own language, the key is recorded once', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.write(`${H}/devices/dB`, { lang: 'en' }, true); // dA has no lang ⇒ Spanish
  db.seed(`${H}/events/dent`, dentist);

  await processAllHouseholds(asDb(db), FIRE + MIN);
  assert.equal(sent.length, 2);
  assert.deepEqual(to(EP_A), {
    title: 'Dentista',
    body: 'Hoy a las 17:00 · Lía · Clínica',
    url: '/#/calendar',
    tag: 'ev_dent_2026-10-22',
  });
  assert.deepEqual(to(EP_B), {
    title: 'Dentista',
    body: 'Today at 17:00 · Lía · Clínica',
    url: '/#/calendar',
    tag: 'ev_dent_2026-10-22',
  });
  assert.deepEqual(sentKeys(db), ['ev_dent_2026-10-22_60']);

  sent = [];
  await processAllHouseholds(asDb(db), FIRE + 6 * MIN);
  assert.equal(sent.length, 0, 'not repeated in any language');
});

test('scheduled: a reminder whose delivery failed is retried on the next run', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.seed(`${H}/events/dent`, dentist);
  failures.set(EP_A, 503).set(EP_B, 503);

  await processAllHouseholds(asDb(db), FIRE + MIN);
  assert.equal(sent.length, 0);
  assert.deepEqual(sentKeys(db), [], 'not recorded');

  failures.clear();
  await processAllHouseholds(asDb(db), FIRE + 6 * MIN);
  assert.equal(sent.length, 2);
  assert.deepEqual(sentKeys(db), ['ev_dent_2026-10-22_60']);
});

test('scheduled: recorded if any device got it, retried if every target failed temporarily', async () => {
  const birthday = { title: 'Lía', kind: 'birthday', date: '2020-10-29', repeat: 'yearly', remindDays: 0 };
  const now = zonedToUtc('2026-10-29', '12:00', TZ);

  const db = new FakeFirestore();
  seedHousehold(db);
  db.write(`${H}/devices/dB`, { lang: 'en' }, true);
  db.seed(`${H}/dates/blia`, birthday);
  failures.set(EP_A, 500);
  await processAllHouseholds(asDb(db), now);
  assert.equal(sent.length, 1);
  assert.equal(to(EP_B)?.title, "🎂 Lía's birthday");
  assert.equal(to(EP_B)?.body, 'Turns 6 today!');
  assert.deepEqual(sentKeys(db), ['kd_blia_2026-10-29_0']);
  assert.equal(meta(db)?.keyDatesOn, '2026-10-29');

  const db2 = new FakeFirestore();
  seedHousehold(db2);
  db2.write(`${H}/devices/dB`, { lang: 'en' }, true);
  db2.seed(`${H}/dates/blia`, birthday);
  failures.set(EP_B, 500);
  sent = [];
  await processAllHouseholds(asDb(db2), now);
  assert.equal(sent.length, 0);
  assert.deepEqual(sentKeys(db2), [], 'retried on the next run');
  assert.equal(meta(db2)?.keyDatesOn ?? null, null, 'key dates not done for today');
  failures.clear();
  await processAllHouseholds(asDb(db2), now + 5 * MIN);
  assert.equal(to(EP_A)?.body, '¡Hoy cumple 6 años!');
  assert.equal(to(EP_B)?.body, 'Turns 6 today!');
  assert.deepEqual(sentKeys(db2), ['kd_blia_2026-10-29_0']);
});

test('scheduled: a payload the push service rejects (413) is not retried', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.seed(`${H}/events/dent`, dentist);
  failures.set(EP_A, 413).set(EP_B, 413);
  await processAllHouseholds(asDb(db), FIRE + MIN);
  assert.deepEqual(sentKeys(db), ['ev_dent_2026-10-22_60']);
  assert.ok(logs.some((l) => l.level === 'error' && l.message === 'Push rejected'));
});

test('scheduled: deletes expired devices (410)', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.seed(`${H}/events/e`, { ...dentist, startTime: '12:00', reminderMins: 0 });
  failures.set(EP_B, 410);
  await processAllHouseholds(asDb(db), zonedToUtc('2026-10-22', '12:01', TZ));
  assert.equal(sent.length, 1);
  assert.equal(db.get(`${H}/devices/dB`), undefined);
  assert.ok(db.get(`${H}/devices/dA`));
});

test("scheduled: devices of non-members or unknown push services don't receive anything", async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.seed(`${H}/devices/dX`, { uid: 'stranger', subscription: sub('https://fcm.googleapis.com/fcm/send/X'), ua: '' });
  db.seed(`${H}/devices/dE`, { uid: 'uA', subscription: sub('https://evil.example/push'), ua: '' });
  db.seed(`${H}/events/dent`, dentist);
  await processAllHouseholds(asDb(db), FIRE + MIN);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), [EP_A, EP_B].sort());
});

test("scheduled: malformed documents don't stop the household's notifications", async () => {
  for (const order of [
    ['e1', 'e2'],
    ['e2', 'e1'],
  ]) {
    const db = new FakeFirestore();
    seedHousehold(db);
    // Two events at the same time, one without a title (sorting used to throw)
    const [first, second] = order as [string, string];
    const untitled = { ...dentist, title: undefined };
    db.seed(`${H}/events/${first}`, first === 'e1' ? untitled : dentist);
    db.seed(`${H}/events/${second}`, second === 'e1' ? untitled : dentist);
    db.seed(`${H}/events/bad`, { ...dentist, date: 'tomorrow' });
    db.seed(`${H}/events/badTime`, { ...dentist, startTime: 'noon', recurrence: { freq: 'daily', interval: 0 } });
    db.seed(`${H}/dates/nodate`, { title: 'X', kind: 'bill', repeat: 'none', remindDays: 0 });
    db.seed(`${H}/tasks/notitle`, { done: false, due: '2026-10-22' });
    sent = [];
    await processAllHouseholds(asDb(db), FIRE + MIN);
    assert.deepEqual(
      sent.map((s) => s.payload.title).sort(),
      ['Dentista', 'Dentista', 'Evento', 'Evento'],
      order.join(),
    );
  }
});

test("scheduled: one failing household doesn't stop the others, and its id isn't logged", async () => {
  const db = new FakeFirestore();
  seedHousehold(db, 'households/h1');
  seedHousehold(db, 'households/secret-household-id');
  db.seed('households/h1/events/dent', dentist);
  db.seed('households/secret-household-id/events/dent', dentist);
  db.failReadsUnder('households/secret-household-id/events');

  await assert.rejects(processAllHouseholds(asDb(db), FIRE + MIN), /1 household\(s\) failed/);
  assert.equal(sent.length, 2, "the other household's phones");
  const error = logs.find((l) => l.message === 'Household failed');
  assert.match(String(error?.fields?.household), /^h_[0-9a-f]{10}$/);
  assert.ok(!JSON.stringify(logs).includes('secret-household-id'), 'no raw household id in the logs');
});

test('scheduled: households without devices are skipped after one read', async () => {
  const db = new FakeFirestore();
  db.seed(H, { name: 'Casa', timezone: TZ, memberUids: ['uA'], members: [] });
  db.seed(`${H}/events/dent`, dentist);
  await processAllHouseholds(asDb(db), FIRE + MIN);
  assert.equal(db.readsUnder(`${H}/`), 1);
  assert.equal(meta(db), undefined, 'nothing written');
});

test('scheduled: a daily summary with nothing to say is recorded once and not reloaded', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.seed(`${H}/tasks/t`, { title: 'Algún día', done: false, due: null });
  await processAllHouseholds(asDb(db), zonedToUtc('2026-10-22', '08:00', TZ));
  assert.equal(sent.length, 0);
  assert.deepEqual(sentKeys(db, 'daily'), ['daily_2026-10-22_uA', 'daily_2026-10-22_uB']);
  const tasksRead = db.readsUnder(`${H}/tasks`);
  assert.equal(tasksRead, 1);
  await processAllHouseholds(asDb(db), zonedToUtc('2026-10-22', '08:05', TZ));
  assert.equal(db.readsUnder(`${H}/tasks`), tasksRead, 'tasks not read again');
});

test('scheduled: key dates are read once a day', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.write(H, { notify: { dailySummary: false } }, true);
  db.seed(`${H}/dates/k`, { title: 'ITV', kind: 'car', date: '2026-12-01', repeat: 'none', remindDays: 7 });
  const at = (d: string, t: string) => processAllHouseholds(asDb(db), zonedToUtc(d, t, TZ));
  await at('2026-10-22', '08:55');
  assert.equal(db.readsUnder(`${H}/dates`), 0, 'not before 09:00');
  await at('2026-10-22', '09:05');
  assert.equal(db.readsUnder(`${H}/dates`), 1);
  assert.equal(meta(db)?.keyDatesOn, '2026-10-22');
  await at('2026-10-22', '09:10');
  await at('2026-10-22', '18:00');
  assert.equal(db.readsUnder(`${H}/dates`), 1);
  await at('2026-10-23', '09:00');
  assert.equal(db.readsUnder(`${H}/dates`), 2);
});

test('scheduled: meta is only written when something changed', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.write(H, { notify: { dailySummary: false } }, true);
  await processAllHouseholds(asDb(db), zonedToUtc('2026-10-22', '10:00', TZ)); // key dates checked: written
  const stored = db.store.get(`${H}/meta/notifier`);
  assert.ok(stored);
  await processAllHouseholds(asDb(db), zonedToUtc('2026-10-22', '10:05', TZ));
  assert.equal(db.store.get(`${H}/meta/notifier`), stored, 'same stored object: not rewritten');
});

test('scheduled: daily cleanup of old activity, expired invites, stray devices and the old log', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  const now = zonedToUtc('2026-10-22', '03:05', TZ);
  const DAY = 24 * 60 * MIN;
  db.seed(`${H}/activity/old`, { actorUid: 'uA', kind: 'note', text: 'x', createdAt: now - 8 * DAY, notified: true });
  db.seed(`${H}/activity/new`, { actorUid: 'uA', kind: 'note', text: 'x', createdAt: now - DAY, notified: true });
  db.seed(`${H}/invites/expired`, { householdName: 'Casa', createdBy: 'uA', createdAt: 0, expiresAt: now - 1 });
  db.seed(`${H}/invites/valid`, { householdName: 'Casa', createdBy: 'uA', createdAt: 0, expiresAt: now + DAY });
  db.seed(`${H}/notifyLog/ev_x_2026-10-01_0`, { at: now - 20 * DAY });
  db.seed(`${H}/devices/dLeft`, {
    uid: 'someone-who-left',
    subscription: sub('https://fcm.googleapis.com/fcm/send/L'),
  });
  db.seed(`${H}/devices/dEvil`, { uid: 'uA', subscription: sub('https://evil.example/x') });
  db.seed(`${H}/devices/dBroken`, { uid: 'uA', subscription: { endpoint: EP_A } });

  await processAllHouseholds(asDb(db), now);
  const left = [...db.store.keys()].filter((p) => p.startsWith(`${H}/`)).sort();
  assert.deepEqual(left, [
    `${H}/activity/new`,
    `${H}/devices/dA`,
    `${H}/devices/dB`,
    `${H}/invites/valid`,
    `${H}/meta/notifier`,
  ]);
  assert.equal(meta(db)?.cleanedOn, '2026-10-22');
  const invitesRead = db.readsUnder(`${H}/invites`);
  await processAllHouseholds(asDb(db), now + 5 * MIN);
  assert.equal(db.readsUnder(`${H}/invites`), invitesRead, 'once a day');
});

test('scheduled: households without devices are still cleaned up, during the cleanup hour', async () => {
  const db = new FakeFirestore();
  db.seed(H, { name: 'Casa', timezone: TZ, memberUids: ['uA'], members: [] });
  db.seed(`${H}/invites/expired`, { expiresAt: 1 });
  await processAllHouseholds(asDb(db), zonedToUtc('2026-10-22', '02:55', TZ));
  assert.ok(db.get(`${H}/invites/expired`));
  await processAllHouseholds(asDb(db), zonedToUtc('2026-10-22', '03:00', TZ));
  assert.equal(db.get(`${H}/invites/expired`), undefined);
});

test('scheduled: keys recorded by the previous version (notifyLog) are honoured, then migrated', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.seed(`${H}/events/dent`, dentist);
  db.seed(`${H}/meta/notifier`, { lastRunAt: FIRE - 4 * MIN });
  db.seed(`${H}/notifyLog/ev_dent_2026-10-22_60`, { at: FIRE });
  await processAllHouseholds(asDb(db), FIRE + MIN);
  assert.equal(sent.length, 0);
  assert.deepEqual(sentKeys(db), ['ev_dent_2026-10-22_60']);
  assert.equal((meta(db) as Record<string, unknown>).lastRunAt, undefined);
});

test('scheduled: leaves recent activity to the instant function', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  const now = zonedToUtc('2026-10-22', '12:00', TZ);
  const activity = { actorUid: 'uA', actorName: 'Alex', kind: 'shopping', notified: false };
  db.seed(`${H}/activity/x1`, { ...activity, text: 'leche', createdAt: now - 30_000 });
  db.seed(`${H}/activity/x2`, { ...activity, text: 'pan', createdAt: now - 10 * MIN });
  await processAllHouseholds(asDb(db), now);
  assert.equal(sent.length, 1, 'only the old one (pan), to the other phone');
  assert.equal(sent[0]?.endpoint, EP_B);
  assert.match(sent[0]?.payload.body ?? '', /pan/);
  assert.equal(db.get(`${H}/activity/x1`)?.notified, false);
  assert.equal(db.get(`${H}/activity/x2`)?.notified, true);
});

test('scheduled: with activity notifications off, pending activity is only marked', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.write(H, { notify: { dailySummary: false, activity: false } }, true);
  const now = zonedToUtc('2026-10-22', '12:00', TZ);
  db.seed(`${H}/activity/x`, {
    actorUid: 'uA',
    kind: 'note',
    text: 'Wifi',
    createdAt: now - 10 * MIN,
    notified: false,
  });
  await processAllHouseholds(asDb(db), now);
  assert.equal(sent.length, 0);
  assert.equal(db.get(`${H}/activity/x`)?.notified, true);
});

test('writes that fail are logged, never an unhandled rejection', async () => {
  const db = new FakeFirestore();
  const w = writer(asDb(db), 'secret-household-id');
  w.update(asDb(db).doc('households/secret-household-id/activity/missing'), { notified: true });
  await w.close();
  const warning = logs.find((l) => l.message === 'Write failed');
  assert.equal(warning?.fields?.doc, 'activity/missing');
  assert.ok(!JSON.stringify(logs).includes('secret-household-id'));
});

// =====================================================================
// Instant activity notification
// =====================================================================

const item = (actorUid: string, actorName: string, text: string, createdAt: number, notified = false) => ({
  actorUid,
  actorName,
  kind: 'shopping',
  text,
  createdAt,
  notified,
});

test('instant: a burst from the same person arrives as a single notification', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  const now = Date.now();
  db.seed(`${H}/activity/a1`, item('uB', 'Sam', 'leche', now - 3000));
  db.seed(`${H}/activity/a2`, item('uB', 'Sam', 'pan', now - 2000));
  db.seed(`${H}/activity/a3`, item('uB', 'Sam', 'huevos', now - 1000));

  // The triggers for a1 and a2 see there's a newer one and send nothing
  await instant(db, 'a1');
  await instant(db, 'a2');
  assert.equal(sent.length, 0);

  await instant(db, 'a3');
  assert.equal(sent.length, 1, "one notification, only to Alex's phone");
  assert.equal(sent[0]?.endpoint, EP_A);
  assert.equal(sent[0]?.payload.title, 'Sam');
  assert.match(sent[0]?.payload.body ?? '', /leche, pan y huevos/);
  assert.equal(sent[0]?.payload.url, '/#/shopping');
  assert.equal(sent[0]?.ttl, 3600);
  for (const id of ['a1', 'a2', 'a3']) assert.equal(db.get(`${H}/activity/${id}`)?.notified, true);

  // A repeated trigger doesn't notify again
  await instant(db, 'a3');
  assert.equal(sent.length, 1);
});

test('instant: items added at the same instant (a pasted list) give exactly one notification', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  const now = Date.now();
  for (const [id, text] of [
    ['p1', 'leche'],
    ['p2', 'pan'],
    ['p3', 'huevos'],
  ] as const) {
    db.seed(`${H}/activity/${id}`, item('uB', 'Sam', text, now));
  }
  await Promise.all(['p3', 'p1', 'p2'].map((id) => instant(db, id)));
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.payload.body ?? '', /leche, pan y huevos/);
});

test("instant: the others step aside at once; only the latest waits what's left of the debounce", async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  const now = Date.now();
  db.seed(`${H}/activity/f1`, item('uB', 'Sam', 'leche', now - 500), now - 500);
  db.seed(`${H}/activity/f2`, item('uB', 'Sam', 'pan', now - 400), now - 400);

  let t = Date.now();
  await instant(db, 'f1', 5000, now - 500);
  assert.ok(Date.now() - t < 1000, 'f1 returned without waiting');
  assert.equal(sent.length, 0);

  t = Date.now();
  await instant(db, 'f2', 1000, now - 400);
  const waited = Date.now() - t;
  assert.ok(waited >= 400 && waited < 1500, `waited ${waited} ms`);
  assert.equal(sent.length, 1);
});

test('instant: nobody to tell ⇒ marked right away, without waiting', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.store.delete(`${H}/devices/dA`); // only the actor's own phone is left
  db.seed(`${H}/activity/z`, item('uB', 'Sam', 'leche', Date.now()));
  const t = Date.now();
  await instant(db, 'z', 5000);
  assert.ok(Date.now() - t < 1000);
  assert.equal(sent.length, 0);
  assert.equal(db.get(`${H}/activity/z`)?.notified, true);
});

test('instant: each device in its own language, items marked once', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.write(`${H}/devices/dB`, { lang: 'en' }, true);
  db.write(H, { memberUids: ['uA', 'uB', 'uC'] }, true); // uC joined but has no member entry yet
  const now = Date.now();
  db.seed(`${H}/activity/n1`, item('uC', 'Noa', 'leche', now - 2000));
  db.seed(`${H}/activity/n2`, item('uC', 'Noa', 'pan', now - 1000));
  await instant(db, 'n2');
  assert.equal(sent.length, 2);
  assert.equal(to(EP_A)?.title, 'Noa');
  assert.equal(to(EP_A)?.body, 'Ha añadido a la compra: leche y pan');
  assert.equal(to(EP_B)?.body, 'Added to the shopping list: leche and pan');
  assert.equal(to(EP_A)?.tag, to(EP_B)?.tag);
  for (const id of ['n1', 'n2']) assert.equal(db.get(`${H}/activity/${id}`)?.notified, true);
});

test("instant: the actor's name comes from the household, not from the document", async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.seed(`${H}/activity/s`, item('uB', 'Banco: verifica tu cuenta', 'leche', Date.now()));
  await instant(db, 's');
  assert.equal(sent[0]?.payload.title, 'Sam');
});

test('instant: with activity notifications off it only marks', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  db.write(H, { notify: { dailySummary: true, dailyHour: 8, activity: false } }, true);
  db.seed(`${H}/activity/z`, { ...item('uA', 'Alex', 'Wifi', Date.now()), kind: 'note' });
  await instant(db, 'z');
  assert.equal(sent.length, 0);
  assert.equal(db.get(`${H}/activity/z`)?.notified, true);
});

test("instant: the triggering document counts even if the app's clock is off", async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  const now = Date.now();
  // createdAt says two days ago; Firestore created it now
  db.seed(`${H}/activity/skew`, item('uB', 'Sam', 'leche', now - 2 * 24 * 60 * MIN), now);
  await instant(db, 'skew');
  assert.equal(sent.length, 1);
  assert.equal(db.get(`${H}/activity/skew`)?.notified, true);
});

test('instant: two people at once get one notification each', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  const now = Date.now();
  db.seed(`${H}/activity/x`, item('uA', 'Alex', 'leche', now - 1000));
  db.seed(`${H}/activity/y`, item('uB', 'Sam', 'pan', now - 900));
  await Promise.all([instant(db, 'x'), instant(db, 'y')]);
  assert.equal(to(EP_B)?.title, 'Alex');
  assert.equal(to(EP_A)?.title, 'Sam');
  assert.equal(sent.length, 2);
});

test('instant: a late trigger after a newer one was sent still notifies, replacing it', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  const now = Date.now();
  db.seed(`${H}/activity/old`, item('uB', 'Sam', 'leche', now - 2000));
  db.seed(`${H}/activity/new`, item('uB', 'Sam', 'pan', now - 1000, true));
  await instant(db, 'old');
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.payload.body ?? '', /leche y pan/);
  assert.equal(sent[0]?.payload.tag, `act_uB_${now - 2000}`);
  assert.equal(db.get(`${H}/activity/old`)?.notified, true);
});

test('instant: a missing household or activity does nothing', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  await instant(db, 'nope');
  const empty = new FakeFirestore();
  await processActivity(asDb(empty), href(empty), 'x', { createTime: Date.now(), debounceMs: 0 });
  assert.equal(sent.length, 0);
});

// =====================================================================
// Each person's choices (prefs/{uid}.notify)
// =====================================================================

const prefs = (db: FakeFirestore, uid: string, notify: Record<string, unknown>) =>
  db.seed(`${H}/prefs/${uid}`, { notify, dashboard: [], updatedAt: 0 });
const menuToday = (db: FakeFirestore) => db.seed(`${H}/menu/2026-10-22`, { lunch: 'Lentejas' });
const at = (db: FakeFirestore, time: string, date = '2026-10-22') =>
  processAllHouseholds(asDb(db), zonedToUtc(date, time, TZ));

test('prefs, instant: each person only gets the kinds they chose', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  prefs(db, 'uA', { activity: { shopping: false } });
  const now = Date.now();
  db.seed(`${H}/activity/s1`, item('uB', 'Sam', 'leche', now - 2000));
  const t = Date.now();
  await instant(db, 's1', 5000, now - 2000);
  assert.ok(Date.now() - t < 1000, 'nobody wants it: no waiting');
  assert.equal(sent.length, 0);
  assert.equal(db.get(`${H}/activity/s1`)?.notified, true);

  db.seed(`${H}/activity/e1`, { ...item('uB', 'Sam', 'Cine', now - 1000), kind: 'event' });
  await instant(db, 'e1');
  assert.equal(sent.length, 1);
  assert.equal(to(EP_A)?.body, 'Nuevo evento: Cine', 'the shopping line is left out');
});

test('prefs, instant: a mixed burst is filtered per person, the actor gets nothing', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  prefs(db, 'uA', { activity: { event: false } });
  prefs(db, 'uB', { activity: { shopping: true, event: true } });
  const now = Date.now();
  db.seed(`${H}/activity/m1`, item('uB', 'Sam', 'leche', now - 3000));
  db.seed(`${H}/activity/m2`, { ...item('uB', 'Sam', 'Cine', now - 2000), kind: 'event' });
  db.seed(`${H}/activity/m3`, item('uB', 'Sam', 'pan', now - 1000));
  for (const id of ['m1', 'm2', 'm3']) await instant(db, id);
  assert.deepEqual(sent, [
    {
      endpoint: EP_A,
      payload: {
        title: 'Sam',
        body: 'Ha añadido a la compra: leche y pan',
        url: '/#/shopping',
        tag: `act_uB_${now - 3000}`,
      },
      ttl: 3600,
    },
  ]);
  for (const id of ['m1', 'm2', 'm3']) assert.equal(db.get(`${H}/activity/${id}`)?.notified, true);
});

test('prefs, scheduled: activity the instant path missed is filtered the same way', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  prefs(db, 'uB', { activity: { note: false } });
  const now = zonedToUtc('2026-10-22', '16:00', TZ);
  db.seed(`${H}/activity/n`, { ...item('uA', 'Alex', 'Wifi', now - 10 * MIN), kind: 'note' });
  db.seed(`${H}/activity/t`, { ...item('uA', 'Alex', 'Basura', now - 10 * MIN), kind: 'task' });
  await processAllHouseholds(asDb(db), now);
  assert.equal(sent.length, 1);
  assert.equal(to(EP_B)?.body, 'Nueva tarea: Basura');
});

test('prefs: event reminders and key dates only to whoever wants them', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  prefs(db, 'uB', { reminders: false });
  prefs(db, 'uA', { keyDates: false });
  db.seed(`${H}/events/dent`, dentist);
  db.seed(`${H}/dates/b`, { title: 'Lía', kind: 'birthday', date: '2020-10-22', repeat: 'yearly', remindDays: 0 });
  await processAllHouseholds(asDb(db), FIRE + MIN);
  assert.deepEqual(
    sent.map((s) => [s.endpoint, s.payload.title]),
    [
      [EP_A, 'Dentista'],
      [EP_B, '🎂 Cumpleaños de Lía'],
    ],
  );
});

test('prefs: each person gets the morning summary at their own hour, once', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  menuToday(db);
  prefs(db, 'uB', { dailyHour: 10 });
  await at(db, '08:05');
  assert.deepEqual(
    sent.map((s) => [s.endpoint, s.payload.body]),
    [[EP_A, '🍽️ Comida: Lentejas']],
  );
  assert.deepEqual(sentKeys(db, 'daily'), ['daily_2026-10-22_uA']);
  sent = [];
  await at(db, '09:30');
  assert.equal(sent.length, 0);
  await at(db, '10:05');
  assert.deepEqual(
    sent.map((s) => s.endpoint),
    [EP_B],
  );
  sent = [];
  await at(db, '10:10');
  await at(db, '12:00');
  assert.equal(sent.length, 0);
  assert.deepEqual(sentKeys(db, 'daily'), ['daily_2026-10-22_uA', 'daily_2026-10-22_uB']);
});

test('prefs: without choices of their own, the household settings of earlier versions apply', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  menuToday(db);
  db.write(H, { notify: { dailySummary: true, dailyHour: 9, activity: true } }, true);
  prefs(db, 'uB', { dailyHour: 8 });
  await at(db, '08:05');
  assert.deepEqual(
    sent.map((s) => s.endpoint),
    [EP_B],
  );
  await at(db, '09:05');
  assert.deepEqual(
    sent.map((s) => s.endpoint),
    [EP_B, EP_A],
  );
});

test('prefs: turned off, or no device, means no morning summary (and done for the day)', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  menuToday(db);
  db.write(H, { memberUids: ['uA', 'uB', 'uC'] }, true); // uC has no device
  prefs(db, 'uB', { daily: false });
  await at(db, '08:05');
  assert.deepEqual(
    sent.map((s) => s.endpoint),
    [EP_A],
  );
  assert.deepEqual(sentKeys(db, 'daily'), ['daily_2026-10-22_uA', 'daily_2026-10-22_uB', 'daily_2026-10-22_uC']);
  const prefsRead = db.readsUnder(`${H}/prefs`);
  await at(db, '08:10');
  assert.equal(db.readsUnder(`${H}/prefs`), prefsRead, 'everyone is done: choices not read again');
});

test('prefs: a household-wide summary recorded before this version counts for everyone that day', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  menuToday(db);
  const earlier = zonedToUtc('2026-10-22', '08:00', TZ);
  db.seed(`${H}/meta/notifier`, { sent: { 'daily_2026-10-22': earlier }, keyDatesOn: null, cleanedOn: '2026-10-22' });
  await at(db, '08:05');
  assert.equal(sent.length, 0);
  assert.equal(db.readsUnder(`${H}/tasks`), 0, 'tasks not loaded');
  assert.equal(db.readsUnder(`${H}/prefs`), 0, 'choices not read');
  // The next day it's per person again
  db.seed(`${H}/menu/2026-10-23`, { lunch: 'Sopa' });
  await at(db, '08:05', '2026-10-23');
  assert.equal(sent.length, 2);
});

test('prefs: choices are only read when something may be due', async () => {
  const db = new FakeFirestore();
  seedHousehold(db);
  await at(db, '05:00'); // before any morning summary can be due
  assert.equal(db.readsUnder(`${H}/prefs`), 0);
  await at(db, '06:00'); // summaries may be due: read once per person with a device
  assert.equal(db.readsUnder(`${H}/prefs`), 2);
  assert.equal(db.readsUnder(`${H}/tasks`), 0, 'no window open yet: tasks not loaded');
  await at(db, '08:05'); // windows open, nothing to say: done for today
  assert.equal(db.readsUnder(`${H}/prefs`), 4);
  assert.equal(db.readsUnder(`${H}/tasks`), 1);
  await at(db, '08:10');
  await at(db, '12:00');
  assert.equal(db.readsUnder(`${H}/prefs`), 4, 'not read again');
  assert.equal(db.readsUnder(`${H}/tasks`), 1);
  db.seed(`${H}/events/e`, { ...dentist, startTime: '13:00', reminderMins: 0 });
  await at(db, '13:00'); // a reminder is due
  assert.equal(db.readsUnder(`${H}/prefs`), 6);
  assert.equal(sent.length, 2);
});
