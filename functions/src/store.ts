// Firestore reads and writes of the notifier. Every document read goes through
// parse.ts; every write goes through a BulkWriter whose failures are logged
// instead of crashing the run.
import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
} from 'firebase-admin/firestore';
import { addDays, type DateStr, isDateStr } from '../../src/shared/dates';
import { resolveNotify } from '../../src/shared/notify';
import type { Activity, CalEvent, Device, Freq, Household, KeyDate, MenuDay, Task } from '../../src/shared/types';
import { errorText, householdTag, log } from './log';
import { byCreation, DAY, REMINDER_LOOKAHEAD_DAYS, type Recipients } from './logic';
import {
  type Data,
  parseActivity,
  parseDevice,
  parseEvent,
  parseKeyDate,
  parseMenuDay,
  parsePrefs,
  parseTask,
} from './parse';
import { canReceive } from './push';

/** Activity documents are deleted after this long. */
const ACTIVITY_KEEP = 7 * DAY;
const RECURRING: Freq[] = ['daily', 'weekly', 'monthly', 'yearly'];
const NOT_FOUND = 5;

const createdMs = (s: DocumentSnapshot) => s.createTime?.toMillis();

async function docsOf<T>(q: Query, parse: (id: string, d: Data, createTime?: number) => T | null): Promise<T[]> {
  const snap = await q.get();
  return snap.docs.flatMap((s) => {
    const x = parse(s.id, s.data(), createdMs(s));
    return x ? [x] : [];
  });
}

// ---------- household data ----------

/** Events of several queries, each once. */
async function eventsOf(queries: Query[]): Promise<CalEvent[]> {
  const byId = new Map<string, CalEvent>();
  for (const list of await Promise.all(queries.map((q) => docsOf(q, parseEvent)))) {
    for (const e of list) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/**
 * To avoid reading the whole collection on every run, only these are read:
 * one-off events starting from yesterday up to the longest reminder ahead, and
 * all recurring ones.
 */
export const loadEvents = (col: CollectionReference, today: DateStr): Promise<CalEvent[]> =>
  eventsOf([
    col.where('date', '>=', addDays(today, -1)).where('date', '<=', addDays(today, REMINDER_LOOKAHEAD_DAYS)),
    col.where('recurrence.freq', 'in', RECURRING),
  ]);

/** Multi-day events still in progress (for the morning summary). */
export const loadOngoingEvents = (col: CollectionReference, today: DateStr): Promise<CalEvent[]> =>
  eventsOf([col.where('endDate', '>=', today)]);

export const loadPendingTasks = (col: CollectionReference): Promise<Task[]> =>
  docsOf(col.where('done', '==', false), parseTask);

export const loadKeyDates = (col: CollectionReference): Promise<KeyDate[]> => docsOf(col, parseKeyDate);

export async function loadMenuDay(col: CollectionReference, date: DateStr): Promise<MenuDay | null> {
  const s = await col.doc(date).get();
  return s.exists ? parseMenuDay(s.id, s.data() ?? {}) : null;
}

export const loadPendingActivity = (col: CollectionReference): Promise<Activity[]> =>
  docsOf(col.where('notified', '==', false), parseActivity);

export const loadDevices = (col: CollectionReference): Promise<Device[]> => docsOf(col, parseDevice);

/**
 * Who can be notified: household members with a device that can receive, each
 * with their choices (prefs/{uid}.notify, one read per person) resolved against
 * the household defaults.
 */
export async function loadRecipients(
  db: Firestore,
  ref: DocumentReference,
  household: Household,
): Promise<{ devices: Device[]; recipients: Recipients }> {
  const devices = await loadDevices(ref.collection('devices'));
  const members = new Set(household.memberUids);
  const uids = [...new Set(devices.filter((d) => canReceive(d) && members.has(d.uid)).map((d) => d.uid))];
  const prefs = uids.length ? await db.getAll(...uids.map((uid) => ref.collection('prefs').doc(uid))) : [];
  const recipients = new Map(uids.map((uid, i) => [uid, resolveNotify(household, parsePrefs(prefs[i]?.data()))]));
  return { devices, recipients };
}

/** Does anyone in the household have notifications on? (One read.) */
export async function hasDevices(col: CollectionReference): Promise<boolean> {
  return !(await col.select().limit(1).get()).empty;
}

/**
 * The same person's activity within `burstMs` of `mine`, oldest first, always
 * including `mine`. Times are the server's (createTime); the query goes by the
 * app's `createdAt`, written by the same device clock as its neighbours.
 */
export async function loadActorBurst(
  col: CollectionReference,
  mine: Activity,
  appCreatedAt: unknown,
  burstMs: number,
): Promise<Activity[]> {
  const anchor =
    typeof appCreatedAt === 'number' && Math.abs(appCreatedAt - mine.createdAt) < DAY ? appCreatedAt : mine.createdAt;
  const docs = await docsOf(col.where('createdAt', '>=', anchor - burstMs), parseActivity);
  const recent = docs.filter((a) => a.actorUid === mine.actorUid && a.createdAt >= mine.createdAt - burstMs);
  if (!recent.some((a) => a.id === mine.id)) recent.push(mine);
  return recent.sort(byCreation);
}

// ---------- notifier state (meta/notifier, server-only) ----------

export interface NotifierState {
  /** Dedupe keys of what was already sent (key → when). */
  sent: Record<string, number>;
  /** Local date on which the key dates were last checked. */
  keyDatesOn: DateStr | null;
  /** Local date of the last daily cleanup. */
  cleanedOn: DateStr | null;
  /** Written by an older version, which kept the sent keys in notifyLog/. */
  legacy: boolean;
}

export async function readState(ref: DocumentReference): Promise<NotifierState> {
  const snap = await ref.get();
  const d: Data = snap.data() ?? {};
  const raw = typeof d.sent === 'object' && d.sent !== null ? (d.sent as Data) : null;
  const sent: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === 'number') sent[k] = v;
  return {
    sent,
    keyDatesOn: isDateStr(d.keyDatesOn) ? d.keyDatesOn : null,
    cleanedOn: isDateStr(d.cleanedOn) ? d.cleanedOn : null,
    legacy: snap.exists && raw === null,
  };
}

export function sameState(a: NotifierState, b: NotifierState): boolean {
  const ka = Object.keys(a.sent);
  return (
    a.legacy === b.legacy &&
    a.keyDatesOn === b.keyDatesOn &&
    a.cleanedOn === b.cleanedOn &&
    ka.length === Object.keys(b.sent).length &&
    ka.every((k) => a.sent[k] === b.sent[k])
  );
}

export async function writeState(ref: DocumentReference, s: NotifierState): Promise<void> {
  await ref.set({ sent: s.sent, keyDatesOn: s.keyDatesOn, cleanedOn: s.cleanedOn });
}

/** Keys that an older version recorded in notifyLog/ (read only while the state is legacy). */
export async function legacySentKeys(db: Firestore, col: CollectionReference, keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const snaps = await db.getAll(...keys.map((k) => col.doc(k)));
  return snaps.filter((s) => s.exists).map((s) => s.id);
}

// ---------- writes ----------

export interface Writer {
  update(ref: DocumentReference, data: Data): void;
  delete(ref: DocumentReference): void;
  close(): Promise<void>;
}

/**
 * A BulkWriter that logs failed writes (a missing document, a lost race…).
 * Its operations return promises nobody awaits: without a handler each failure
 * would be an unhandled rejection and crash the process.
 */
export function writer(db: Firestore, hid: string): Writer {
  const w = db.bulkWriter();
  w.onWriteError((e) => e.code !== NOT_FOUND && e.failedAttempts < 3);
  const track = (ref: DocumentReference, p: Promise<unknown>) => {
    p.catch((e: unknown) =>
      log.warn('Write failed', {
        household: householdTag(hid),
        doc: `${ref.parent.id}/${ref.id}`,
        error: errorText(e, hid),
      }),
    );
  };
  return {
    update: (ref, data) => track(ref, w.update(ref, data)),
    delete: (ref) => track(ref, w.delete(ref)),
    close: () => w.close(),
  };
}

/**
 * Daily housekeeping: activity older than a week, expired invites, devices that
 * can't or mustn't receive anything (incomplete, unknown push service, owner no
 * longer in the household) and the dedupe log of older versions.
 */
export async function cleanup(db: Firestore, ref: DocumentReference, household: Household, now: number) {
  const [oldActivity, expiredInvites, legacyLog, devices] = await Promise.all([
    ref
      .collection('activity')
      .where('createdAt', '<', now - ACTIVITY_KEEP)
      .select()
      .get(),
    ref.collection('invites').where('expiresAt', '<', now).select().get(),
    ref.collection('notifyLog').select().limit(500).get(),
    ref.collection('devices').get(),
  ]);
  const members = new Set(household.memberUids);
  const strayDevices = devices.docs.filter((s) => {
    const d = parseDevice(s.id, s.data());
    return !d || !canReceive(d) || (members.size > 0 && !members.has(d.uid));
  });
  const doomed = [...oldActivity.docs, ...expiredInvites.docs, ...legacyLog.docs, ...strayDevices];
  const w = writer(db, household.id);
  for (const s of doomed) w.delete(s.ref);
  await w.close();
  return doomed.length;
}
