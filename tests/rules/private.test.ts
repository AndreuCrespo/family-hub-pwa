// Per-user and server-owned data: prefs, meta, devices, activity, notifyLog,
// plus paths that must not exist at all.
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, type Firestore, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALICE,
  activity,
  as,
  BOB,
  device,
  EVE,
  HID,
  HOUR,
  LIMITS,
  prefs,
  seed,
  seedHousehold,
  setupRulesEnv,
  str,
} from './helpers';

setupRulesEnv();

const sub = (db: Firestore, coll: string, id: string) => doc(db, 'households', HID, coll, id);

beforeEach(() => seedHousehold());

describe('prefs (own document only)', () => {
  it('a member writes (with merge) and reads their own prefs', async () => {
    const db = as(ALICE);
    await assertSucceeds(setDoc(sub(db, 'prefs', ALICE), prefs(), { merge: true }));
    await assertSucceeds(
      setDoc(sub(db, 'prefs', ALICE), prefs({ dashboard: { order: [], hidden: ['energy'] } }), { merge: true }),
    );
    await assertSucceeds(getDoc(sub(db, 'prefs', ALICE)));
    await assertSucceeds(deleteDoc(sub(db, 'prefs', ALICE)));
  });

  it("cannot read or write another member's prefs, or list them", async () => {
    await seed(`households/${HID}/prefs/${BOB}`, prefs());
    const db = as(ALICE);
    await assertFails(getDoc(sub(db, 'prefs', BOB)));
    await assertFails(setDoc(sub(db, 'prefs', BOB), prefs(), { merge: true }));
    await assertFails(deleteDoc(sub(db, 'prefs', BOB)));
    await assertFails(getDocs(collection(db, 'households', HID, 'prefs')));
  });

  it('non-members cannot store prefs in the household', async () => {
    await assertFails(setDoc(sub(as(EVE), 'prefs', EVE), prefs(), { merge: true }));
  });

  it('rejects malformed prefs', async () => {
    const db = as(ALICE);
    const many = Array.from({ length: LIMITS.dashboardWidgets + 1 }, (_, i) => `w${i}`);
    await assertSucceeds(setDoc(sub(db, 'prefs', ALICE), prefs({ dashboard: { order: many.slice(1), hidden: [] } })));
    await assertFails(setDoc(sub(db, 'prefs', ALICE), prefs({ dashboard: { order: many, hidden: [] } })));
    await assertFails(setDoc(sub(db, 'prefs', ALICE), prefs({ dashboard: { order: 'agenda', hidden: [] } })));
    await assertFails(setDoc(sub(db, 'prefs', ALICE), prefs({ dashboard: { order: [], hidden: [], theme: 'dark' } })));
    await assertFails(setDoc(sub(db, 'prefs', ALICE), prefs({ updatedAt: 'now' })));
    await assertFails(setDoc(sub(db, 'prefs', ALICE), { dashboard: { order: [], hidden: [] } }));
    await assertFails(setDoc(sub(db, 'prefs', ALICE), prefs({ theme: 'dark' })));
  });
});

describe('prefs.notify (personal notification choices)', () => {
  const KINDS = ['shopping', 'event', 'task', 'note', 'expense', 'date', 'menu'];
  const mine = (db: Firestore) => sub(db, 'prefs', ALICE);
  const merge = (db: Firestore, notify: unknown) =>
    setDoc(mine(db), { notify, updatedAt: Date.now() }, { merge: true });

  it('accepts every key on its own', async () => {
    const db = as(ALICE);
    for (const kind of KINDS) {
      await assertSucceeds(merge(db, { activity: { [kind]: false } }));
      await assertSucceeds(merge(db, { activity: { [kind]: true } }));
    }
    await assertSucceeds(merge(db, { reminders: false }));
    await assertSucceeds(merge(db, { keyDates: true }));
    await assertSucceeds(merge(db, { daily: false }));
    await assertSucceeds(merge(db, { dailyHour: 0 }));
    await assertSucceeds(merge(db, { dailyHour: 23 }));
  });

  it('accepts partial and complete maps, with or without a dashboard', async () => {
    const db = as(ALICE);
    // A notify-only document (no dashboard saved yet).
    await assertSucceeds(merge(db, { activity: { shopping: false } }));
    await assertSucceeds(merge(db, { daily: true, dailyHour: 7 }));
    await assertSucceeds(merge(db, {}));
    await assertSucceeds(
      setDoc(mine(db), {
        notify: {
          activity: Object.fromEntries(KINDS.map((k) => [k, true])),
          reminders: true,
          keyDates: false,
          daily: true,
          dailyHour: 9,
        },
        updatedAt: Date.now(),
      }),
    );
  });

  it('merging notify keeps the dashboard and earlier choices', async () => {
    const db = as(ALICE);
    await assertSucceeds(setDoc(mine(db), prefs(), { merge: true }));
    await assertSucceeds(merge(db, { activity: { shopping: false } }));
    await assertSucceeds(merge(db, { daily: true, dailyHour: 7 }));
    await assertSucceeds(
      setDoc(mine(db), { dashboard: { order: ['menu'], hidden: [] }, updatedAt: Date.now() }, { merge: true }),
    );
    const snap = await assertSucceeds(getDoc(mine(db)));
    expect(snap.data()).toMatchObject({
      dashboard: { order: ['menu'], hidden: [] },
      notify: { activity: { shopping: false }, daily: true, dailyHour: 7 },
    });
  });

  it('rejects unknown keys at both levels', async () => {
    const db = as(ALICE);
    await assertFails(merge(db, { sound: true }));
    await assertFails(merge(db, { activity: { login: false } }));
    await assertFails(merge(db, { activity: { shopping: false, groceries: false } }));
    await assertFails(setDoc(mine(db), { notify: { daily: true }, other: 1, updatedAt: Date.now() }, { merge: true }));
  });

  it('rejects values of the wrong type', async () => {
    const db = as(ALICE);
    const bad: unknown[] = [
      true,
      'all',
      { activity: true },
      { activity: ['shopping'] },
      { activity: { shopping: 'no' } },
      { activity: { event: 0 } },
      { activity: { task: null } },
      { reminders: 'yes' },
      { keyDates: 1 },
      { daily: null },
      { dailyHour: 24 },
      { dailyHour: -1 },
      { dailyHour: 7.5 },
      { dailyHour: '7' },
    ];
    for (const notify of bad) {
      await assertFails(merge(db, notify));
    }
    await assertFails(setDoc(mine(db), { notify: { daily: true } }));
  });

  it("cannot change another person's choices", async () => {
    await seed(`households/${HID}/prefs/${BOB}`, prefs({ notify: { daily: true } }));
    const db = as(ALICE);
    await assertFails(
      setDoc(sub(db, 'prefs', BOB), { notify: { daily: false }, updatedAt: Date.now() }, { merge: true }),
    );
    await assertFails(updateDoc(sub(db, 'prefs', BOB), { 'notify.daily': false }));
    await assertFails(setDoc(sub(as(EVE), 'prefs', EVE), { notify: { daily: false }, updatedAt: Date.now() }));
  });
});

describe('meta', () => {
  const freq = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`item ${i}`, i + 1]));

  it('members read and merge into meta/shopping', async () => {
    const db = as(ALICE);
    await assertSucceeds(setDoc(sub(db, 'meta', 'shopping'), { freq: { leche: 3 } }, { merge: true }));
    await assertSucceeds(setDoc(sub(db, 'meta', 'shopping'), { freq: { pan: 1 } }, { merge: true }));
    await assertSucceeds(getDoc(sub(as(BOB), 'meta', 'shopping')));
  });

  it('caps the suggestions map', async () => {
    await seed(`households/${HID}/meta/shopping`, { freq: freq(LIMITS.shoppingFreq - 1) });
    const db = as(ALICE);
    await assertSucceeds(setDoc(sub(db, 'meta', 'shopping'), { freq: { extra: 1 } }, { merge: true }));
    await assertFails(setDoc(sub(db, 'meta', 'shopping'), { freq: { 'one too many': 1 } }, { merge: true }));
  });

  it('rejects other fields', async () => {
    await assertFails(setDoc(sub(as(ALICE), 'meta', 'shopping'), { freq: {}, note: 'x' }, { merge: true }));
    await assertFails(setDoc(sub(as(ALICE), 'meta', 'shopping'), { freq: 'leche' }));
  });

  it('non-members have no access', async () => {
    await seed(`households/${HID}/meta/shopping`, { freq: { leche: 1 } });
    await assertFails(getDoc(sub(as(EVE), 'meta', 'shopping')));
    await assertFails(setDoc(sub(as(EVE), 'meta', 'shopping'), { freq: { x: 1 } }, { merge: true }));
  });

  it('meta/notifier and any other meta document are server-only', async () => {
    await seed(`households/${HID}/meta/notifier`, { lastRunAt: Date.now() });
    const db = as(ALICE);
    await assertFails(getDoc(sub(db, 'meta', 'notifier')));
    await assertFails(setDoc(sub(db, 'meta', 'notifier'), { lastRunAt: Date.now() + 365 * 24 * HOUR }));
    await assertFails(setDoc(sub(db, 'meta', 'other'), { freq: {} }));
    await assertFails(getDocs(collection(db, 'households', HID, 'meta')));
  });
});

describe('devices (push subscriptions)', () => {
  const id = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  const withEndpoint = (endpoint: string) =>
    device(ALICE, { subscription: { endpoint, keys: { p256dh: 'BKey', auth: 'AKey' } } });

  it('a member registers, updates and removes their own device', async () => {
    const db = as(ALICE);
    await assertSucceeds(setDoc(sub(db, 'devices', id), device(ALICE)));
    await assertSucceeds(updateDoc(sub(db, 'devices', id), { lang: 'en' }));
    await assertSucceeds(setDoc(sub(db, 'devices', id), device(ALICE, { lang: 'es' })));
    await assertSucceeds(deleteDoc(sub(db, 'devices', id)));
  });

  it('deleting a device that does not exist is allowed', async () => {
    await assertSucceeds(deleteDoc(sub(as(ALICE), 'devices', 'missing')));
  });

  it('clients can never read devices, not even their own', async () => {
    await seed(`households/${HID}/devices/${id}`, device(ALICE));
    await assertFails(getDoc(sub(as(ALICE), 'devices', id)));
    await assertFails(getDocs(collection(as(ALICE), 'households', HID, 'devices')));
  });

  it("cannot register a device for someone else or touch someone else's", async () => {
    await assertFails(setDoc(sub(as(ALICE), 'devices', 'x1'), device(BOB)));
    await seed(`households/${HID}/devices/${id}`, device(BOB));
    await assertFails(updateDoc(sub(as(ALICE), 'devices', id), { lang: 'en' }));
    await assertFails(setDoc(sub(as(ALICE), 'devices', id), device(ALICE)));
    await assertFails(deleteDoc(sub(as(ALICE), 'devices', id)));
  });

  it('non-members cannot register devices', async () => {
    await assertFails(setDoc(sub(as(EVE), 'devices', 'x1'), device(EVE)));
  });

  it('accepts the known push services', async () => {
    const endpoints = [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://fcm.googleapis.com/wp/abc',
      'https://android.googleapis.com/gcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGx_abc',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
    ];
    for (const [i, ep] of endpoints.entries()) {
      await assertSucceeds(setDoc(sub(as(ALICE), 'devices', `ok${i}`), withEndpoint(ep)));
    }
  });

  it('rejects any other endpoint (the notifier would POST to it)', async () => {
    const endpoints = [
      'https://evil.example/fcm.googleapis.com/',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://fcm.googleapis.com/',
      'https://x.notify.windows.com.evil.example/w',
      'https://169.254.169.254/computeMetadata/v1/',
      `https://fcm.googleapis.com/${str(2048)}`,
    ];
    for (const [i, ep] of endpoints.entries()) {
      await assertFails(setDoc(sub(as(ALICE), 'devices', `bad${i}`), withEndpoint(ep)));
    }
  });

  it('rejects malformed devices', async () => {
    const db = as(ALICE);
    const bad = [
      device(ALICE, { lang: 'fr' }),
      device(ALICE, { ua: str(301) }),
      device(ALICE, { createdAt: 'now' }),
      device(ALICE, { expirationTime: null }),
      device(ALICE, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: 'B' } } }),
      device(ALICE, {
        subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: '', auth: 'A' } },
      }),
      device(ALICE, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a' } }),
      device(ALICE, { subscription: 'https://fcm.googleapis.com/fcm/send/a' }),
    ];
    for (const [i, data] of bad.entries()) {
      await assertFails(setDoc(sub(db, 'devices', `bad${i}`), data));
    }
    await assertSucceeds(setDoc(sub(db, 'devices', 'ua'), device(ALICE, { ua: str(300) })));
  });
});

describe('activity (create-only)', () => {
  it('a member logs their own activity', async () => {
    await assertSucceeds(setDoc(sub(as(ALICE), 'activity', 'a1'), activity(ALICE)));
    await assertSucceeds(
      setDoc(
        sub(as(ALICE), 'activity', 'a2'),
        activity(ALICE, {
          kind: 'menu',
          text: str(LIMITS.activityText),
          actorName: str(LIMITS.memberName),
        }),
      ),
    );
  });

  it('cannot impersonate another member', async () => {
    await assertFails(setDoc(sub(as(ALICE), 'activity', 'a1'), activity(BOB)));
  });

  it('createdAt must be within an hour of now', async () => {
    const db = as(ALICE);
    await assertSucceeds(setDoc(sub(db, 'activity', 'a1'), activity(ALICE, { createdAt: Date.now() - HOUR / 2 })));
    await assertFails(setDoc(sub(db, 'activity', 'a2'), activity(ALICE, { createdAt: Date.now() + 2 * HOUR })));
    await assertFails(setDoc(sub(db, 'activity', 'a3'), activity(ALICE, { createdAt: Date.now() - 2 * HOUR })));
    await assertFails(setDoc(sub(db, 'activity', 'a4'), activity(ALICE, { createdAt: 'now' })));
  });

  it('rejects malformed activity', async () => {
    const db = as(ALICE);
    const bad = [
      activity(ALICE, { notified: true }),
      activity(ALICE, { kind: 'login' }),
      activity(ALICE, { text: str(LIMITS.activityText + 1) }),
      activity(ALICE, { actorName: str(LIMITS.memberName + 1) }),
      activity(ALICE, { url: 'https://evil.example' }),
    ];
    for (const [i, data] of bad.entries()) {
      await assertFails(setDoc(sub(db, 'activity', `bad${i}`), data));
    }
  });

  it('clients cannot read, edit or delete activity', async () => {
    await seed(`households/${HID}/activity/a1`, activity(ALICE));
    const db = as(ALICE);
    await assertFails(getDoc(sub(db, 'activity', 'a1')));
    await assertFails(getDocs(collection(db, 'households', HID, 'activity')));
    await assertFails(updateDoc(sub(db, 'activity', 'a1'), { notified: true }));
    await assertFails(deleteDoc(sub(db, 'activity', 'a1')));
  });

  it('non-members cannot log activity', async () => {
    await assertFails(setDoc(sub(as(EVE), 'activity', 'a1'), activity(EVE)));
  });
});

describe('server-only and unknown paths', () => {
  it('notifyLog is closed to clients', async () => {
    await seed(`households/${HID}/notifyLog/daily_2026-10-24`, { at: Date.now() });
    const db = as(ALICE);
    await assertFails(getDoc(sub(db, 'notifyLog', 'daily_2026-10-24')));
    await assertFails(getDocs(collection(db, 'households', HID, 'notifyLog')));
    await assertFails(setDoc(sub(db, 'notifyLog', 'daily_2026-10-25'), { at: Date.now() }));
    await assertFails(deleteDoc(sub(db, 'notifyLog', 'daily_2026-10-24')));
  });

  it('members cannot create other subcollections', async () => {
    await assertFails(setDoc(sub(as(ALICE), 'whatever', 'x'), { a: 1 }));
    await assertFails(setDoc(doc(as(ALICE), 'households', HID, 'events', 'e1', 'nested', 'x'), { a: 1 }));
  });

  it('top-level paths other than households are closed', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'config', 'access'), { creatorUids: [] }));
    await assertFails(setDoc(doc(as(ALICE), 'users', ALICE), { name: 'Alice' }));
    await assertFails(getDoc(doc(as(ALICE), 'users', ALICE)));
  });
});
