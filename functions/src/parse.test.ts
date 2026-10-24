// Tests of the parsing of client-written documents.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseActivity, parseDevice, parseEvent, parseHousehold, parseKeyDate, parsePrefs, parseTask } from './parse';

test('events: dropped without a valid date, bad fields replaced', () => {
  assert.equal(parseEvent('e', {}), null);
  assert.equal(parseEvent('e', { date: '22/10/2026', title: 'X' }), null);
  const e = parseEvent('e', {
    date: '2026-10-22',
    endDate: 'later',
    startTime: '25:00',
    memberIds: ['a', 3, null],
    recurrence: { freq: 'hourly', interval: 1 },
    exdates: ['2026-10-29', 'x'],
    reminderMins: '30',
  });
  assert.deepEqual(e, {
    id: 'e',
    title: '',
    date: '2026-10-22',
    endDate: null,
    startTime: null,
    endTime: null,
    memberIds: ['a'],
    recurrence: null,
    exdates: ['2026-10-29'],
    reminderMins: null,
    location: '',
  });
  assert.deepEqual(
    parseEvent('w', { date: '2026-10-22', recurrence: { freq: 'weekly', byWeekday: [1, 'x'], until: 'never' } })
      ?.recurrence,
    { freq: 'weekly', interval: 1, byWeekday: [1], until: null },
  );
});

test('key dates, tasks and households', () => {
  assert.equal(parseKeyDate('k', { title: 'X', kind: 'bill' }), null);
  assert.deepEqual(parseKeyDate('k', { date: '2026-10-22', kind: 'yacht', repeat: 'weekly', remindDays: 'x' }), {
    id: 'k',
    title: '',
    kind: 'other',
    date: '2026-10-22',
    repeat: 'none',
    remindDays: 0,
    amount: null,
  });
  assert.deepEqual(parseTask('t', { due: 'today', done: 'yes' }), {
    id: 't',
    title: '',
    memberIds: [],
    due: null,
    done: false,
    createdAt: 0,
  });
  const h = parseHousehold('h', { memberUids: ['u1', 7], members: [{ id: 'm', name: 'A', uid: 'u1' }, 'junk', {}] });
  assert.deepEqual(h.memberUids, ['u1']);
  assert.deepEqual(h.members, [{ id: 'm', name: 'A', color: '', kind: 'adult', uid: 'u1' }]);
  assert.equal(h.notify, undefined);
});

test('devices: complete subscriptions only, language normalized', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal(parseDevice('d', { subscription: sub }), null); // no owner
  assert.equal(parseDevice('d', { uid: 'u', subscription: { ...sub, keys: { p256dh: 'p' } } }), null);
  assert.equal(parseDevice('d', { uid: 'u', subscription: 'x' }), null);
  assert.equal(parseDevice('d', { uid: 'u', subscription: sub, lang: 'fr' })?.lang, 'es');
  assert.equal(parseDevice('d', { uid: 'u', subscription: sub, lang: 'en' })?.lang, 'en');
});

test("activity: the server's creation time wins over the app's", () => {
  const a = parseActivity('a', { actorUid: 'u', createdAt: 1, text: 5, notified: 'no' }, 1000);
  assert.deepEqual(a, { id: 'a', actorUid: 'u', actorName: '', kind: '', text: '', createdAt: 1000, notified: false });
  assert.equal(parseActivity('a', { createdAt: 7 }).createdAt, 7);
});

test('prefs: the notify object, or nothing', () => {
  assert.equal(parsePrefs(undefined), null);
  assert.equal(parsePrefs({ dashboard: [] }), null);
  assert.equal(parsePrefs({ notify: 'all' }), null);
  assert.deepEqual(parsePrefs({ notify: { daily: false }, updatedAt: 1 }), { daily: false });
});
