// The notifier's two jobs: the scheduled run (event reminders, daily summary,
// key dates and any activity the instant path missed) and the instant
// "Sam added milk to the shopping list". What to send is decided in logic.ts.
import { setTimeout as sleep } from 'node:timers/promises';
import type { DocumentReference, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { zonedParts } from '../../src/shared/dates';
import type { Activity, Household } from '../../src/shared/types';
import { errorText, householdTag, log } from './log';
import {
  activityDigest,
  byCreation,
  type ComputeInput,
  computeNotifications,
  DAY,
  dailyGateHour,
  dailyKey,
  everyone,
  householdTz,
  KEYDATE_HOUR,
  legacyDailyKey,
  type Message,
  MINUTE,
  openDailyUids,
} from './logic';
import { parseActivity, parseHousehold } from './parse';
import { type DeliveryReport, deliver } from './push';
import * as store from './store';

/** Whatever someone adds within this interval is grouped into a single notification. */
const ACTIVITY_BURST = 10 * MINUTE;
/** The scheduled job only picks up activity that the instant function didn't notify. */
const ACTIVITY_FALLBACK_AGE = 3 * MINUTE;
/** Sent keys are remembered this long (much longer than any catch-up). */
const SENT_KEEP = 2 * DAY;
/** Local hour from which the daily cleanup runs. */
const CLEANUP_HOUR = 3;
/** Households processed at the same time. */
const HOUSEHOLD_CONCURRENCY = 4;
/** Households not started after this long wait for the next run (the timeout is 120 s). */
const RUN_BUDGET_MS = 90_000;
const TICK = 5 * MINUTE;

// ---------- scheduled job ----------

async function processHousehold(db: Firestore, doc: QueryDocumentSnapshot, now: number): Promise<void> {
  const household = parseHousehold(doc.id, doc.data());
  const tz = householdTz(household);
  const { date: today, hour, time } = zonedParts(now, tz);
  const ref = doc.ref;
  const metaRef = ref.collection('meta').doc('notifier');

  const withDevices = await store.hasDevices(ref.collection('devices'));
  // Nobody to notify: only the daily cleanup, during its hour.
  if (!withDevices && hour !== CLEANUP_HOUR) return;

  const state = await store.readState(metaRef);
  const next: store.NotifierState = { ...state, sent: { ...state.sent }, legacy: false };

  if (withDevices) {
    const report = await notifyHousehold(db, ref, household, state, next, now);
    if (report) {
      log.info('Notifications sent', {
        household: householdTag(household.id),
        localTime: `${today} ${time}`,
        tz,
        kinds: report.kinds,
        sent: report.sent,
        langs: report.langs,
        ...(report.errors && { errors: report.errors }),
        ...(report.rejected && { rejected: report.rejected }),
        ...(report.goneDeviceIds.length && { expired: report.goneDeviceIds.length }),
      });
    }
  }

  if (hour >= CLEANUP_HOUR && state.cleanedOn !== today) {
    const deleted = await store.cleanup(db, ref, household, now);
    if (deleted) log.info('Cleanup', { household: householdTag(household.id), deleted });
    next.cleanedOn = today;
  }

  next.sent = Object.fromEntries(Object.entries(next.sent).filter(([, at]) => at >= now - SENT_KEEP));
  if (!store.sameState(state, next)) await store.writeState(metaRef, next);
}

/**
 * Computes, sends and records this run's notifications. Updates `next`; returns
 * what was sent, if anything. People's choices (and the devices) are only read
 * when something may be due: a reminder, a key date, activity, or a morning
 * summary not yet done today.
 */
async function notifyHousehold(
  db: Firestore,
  ref: DocumentReference,
  household: Household,
  state: store.NotifierState,
  next: store.NotifierState,
  now: number,
): Promise<(DeliveryReport & { kinds: string }) | null> {
  const { date: today, hour } = zonedParts(now, householdTz(household));
  const col = (name: string) => ref.collection(name);

  const checkKeyDates = hour >= KEYDATE_HOUR && state.keyDatesOn !== today;
  const [events, keyDates, pending] = await Promise.all([
    store.loadEvents(col('events'), today),
    checkKeyDates ? store.loadKeyDates(col('dates')) : [],
    store.loadPendingActivity(col('activity')),
  ]);
  // Recent activity is notified right away by onActivityCreated; here only what it missed.
  const activity = pending.filter((a) => a.createdAt < now - ACTIVITY_FALLBACK_AGE);
  const base: Omit<ComputeInput, 'recipients'> = {
    household,
    events,
    tasks: [],
    menuToday: null,
    keyDates,
    activity,
    now,
  };

  // First as if everyone wanted everything (but the morning summary): is anything due at all?
  const draft = computeNotifications({ ...base, recipients: everyone(household) });

  const sent = new Set(Object.keys(state.sent));
  if (state.legacy) {
    const keys = [legacyDailyKey(today), ...draft.messages.flatMap((m) => (m.key ? [m.key] : []))];
    for (const k of await store.legacySentKeys(db, col('notifyLog'), keys)) {
      sent.add(k);
      next.sent[k] = now;
    }
  }
  // A household-wide summary recorded by an earlier version counts for everyone that day.
  const dailyDone = (uid: string) => sent.has(dailyKey(today, uid)) || sent.has(legacyDailyKey(today));
  const isFresh = (m: Message) =>
    !m.key || !(sent.has(m.key) || (m.kind === 'daily' && sent.has(legacyDailyKey(today))));
  const dailyPending = hour >= dailyGateHour(household) && household.memberUids.some((uid) => !dailyDone(uid));

  let result = draft;
  let report: DeliveryReport | null = null;
  let fresh: Message[] = [];
  if (dailyPending || draft.messages.some(isFresh)) {
    const { devices, recipients } = await store.loadRecipients(db, ref, household);
    let input: ComputeInput = { ...base, recipients };
    // Tasks, menu and long events only when someone's morning summary is due now.
    if (openDailyUids(recipients, hour).some((uid) => !dailyDone(uid))) {
      const [tasks, menuToday, ongoing, kd] = await Promise.all([
        store.loadPendingTasks(col('tasks')),
        store.loadMenuDay(col('menu'), today),
        store.loadOngoingEvents(col('events'), today),
        checkKeyDates ? keyDates : store.loadKeyDates(col('dates')),
      ]);
      const more = ongoing.filter((e) => !events.some((x) => x.id === e.id));
      input = { ...input, tasks, menuToday, events: [...events, ...more], keyDates: kd };
    }
    result = computeNotifications(input);
    fresh = result.messages.filter(isFresh);
    if (fresh.length) report = await deliver(fresh, devices);
    for (const k of result.quietKeys) next.sent[k] ??= now;
  }

  for (const k of report?.delivered ?? []) next.sent[k] = now;
  // Key dates are done for today unless one of them has to be retried.
  if (checkKeyDates && ![...(report?.failed ?? [])].some((k) => k.startsWith('kd_'))) next.keyDatesOn = today;

  const w = store.writer(db, household.id);
  for (const id of report?.goneDeviceIds ?? []) w.delete(col('devices').doc(id));
  for (const id of result.activityIdsToMark) w.update(col('activity').doc(id), { notified: true });
  await w.close();

  return report && { ...report, kinds: fresh.map((m) => m.kind).join(',') };
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function processAllHouseholds(db: Firestore, now = Date.now()): Promise<void> {
  const snap = await db.collection('households').select('memberUids', 'members', 'timezone', 'notify').get();
  // Start at a different household each run, so none is always the last one.
  const start = snap.docs.length ? Math.floor(now / TICK) % snap.docs.length : 0;
  const docs = [...snap.docs.slice(start), ...snap.docs.slice(0, start)];
  const began = Date.now();
  let failed = 0;
  let postponed = 0;
  await forEachLimit(docs, HOUSEHOLD_CONCURRENCY, async (doc) => {
    if (Date.now() - began > RUN_BUDGET_MS) {
      postponed++;
      return;
    }
    try {
      await processHousehold(db, doc, now);
    } catch (e) {
      failed++;
      log.error('Household failed', { household: householdTag(doc.id), error: errorText(e, doc.id) });
    }
  });
  if (postponed) log.warn('Out of time: households left for the next run', { postponed });
  if (failed) throw new Error(`${failed} household(s) failed`);
}

// ---------- instant: "Sam added milk to the shopping list" ----------

export interface ActivityTrigger {
  /** When Firestore created the activity document (server clock). */
  createTime: number;
  /** How long after `createTime` to wait for more activity from the same person. */
  debounceMs: number;
}

/** Is there activity newer than `mine`, not yet notified? Then its own run takes care of `mine` too. */
const newerPending = (recent: Activity[], mine: Activity) =>
  recent.some((a) => a.id !== mine.id && !a.notified && byCreation(a, mine) > 0);

/**
 * Called when an activity document is created. Things a person adds in a row
 * ("milk, bread, eggs") arrive as a single notification: only the run of the
 * latest one waits and sends; the others step aside right away. Each of the
 * others gets the kinds they chose.
 */
export async function processActivity(
  db: Firestore,
  householdRef: DocumentReference,
  activityId: string,
  trigger: ActivityTrigger,
): Promise<void> {
  const hid = householdRef.id;
  const activityCol = householdRef.collection('activity');
  const [hSnap, mineSnap] = await Promise.all([householdRef.get(), activityCol.doc(activityId).get()]);
  if (!hSnap.exists || !mineSnap.exists) return;
  const mine = parseActivity(mineSnap.id, mineSnap.data() ?? {}, mineSnap.createTime?.toMillis() ?? trigger.createTime);
  if (mine.notified) return; // a newer activity's run already included it
  const household = parseHousehold(hSnap.id, hSnap.data() ?? {});

  const burst = () => store.loadActorBurst(activityCol, mine, mineSnap.get('createdAt'), ACTIVITY_BURST);
  let recent = await burst();
  if (newerPending(recent, mine)) return;

  const { devices, recipients } = await store.loadRecipients(db, householdRef, household);
  // Does anyone else want any of what this burst has so far?
  const wanted = (list: Activity[]) =>
    [...recipients].some(([uid, r]) => uid !== mine.actorUid && list.some((a) => r.activity[a.kind] === true));
  let gone: string[] = [];
  if (wanted(recent)) {
    const wait = Math.min(trigger.createTime + trigger.debounceMs - Date.now(), trigger.debounceMs);
    if (wait > 0) {
      await sleep(wait);
      recent = await burst();
      if (newerPending(recent, mine)) return;
    }
    if (!recent.some((a) => !a.notified)) return; // another run sent it meanwhile
    // Rebuilt with the whole burst so the new notification replaces the previous one.
    const digest = activityDigest(recent, Date.now(), recipients, {
      includeNotified: true,
      members: household.members,
    });
    if (digest.length) gone = (await deliver(digest, devices)).goneDeviceIds;
  }
  // Marked even if nobody wanted it, so the scheduled job doesn't pick it up.
  const w = store.writer(db, hid);
  for (const a of recent) if (!a.notified) w.update(activityCol.doc(a.id), { notified: true });
  for (const id of gone) w.delete(householdRef.collection('devices').doc(id));
  await w.close();
}
