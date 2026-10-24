// External data (weather, electricity prices) shared by every component that
// shows it: one entry per key, cached in localStorage, fetched at most once at a
// time and refreshed while the app is visible and the copy is stale.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { KEYS, keysWithPrefix, readJSON, removeKey, writeJSON } from './storage';

export interface RemoteState<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

interface Cached<T> {
  at: number;
  data: T;
}

/** Checks that a stored copy has the shape the app expects now. */
export type Validator<T> = (data: unknown) => data is T;

interface Entry<T> {
  state: RemoteState<T>;
  fetchedAt: number;
  fetcher: () => Promise<T>;
  ttl: number;
  inflight: boolean;
  timer?: ReturnType<typeof setInterval>;
  subs: Set<() => void>;
}

/** Cached copies older than this are deleted from localStorage. */
const CACHE_MAX_AGE = 3 * 86_400_000;
const entries = new Map<string, Entry<unknown>>();
const IDLE: RemoteState<never> = { loading: false };

/** Deletes copies that are too old or from an earlier format. */
function pruneCache() {
  for (const k of keysWithPrefix(KEYS.cacheRoot)) {
    const c = k.startsWith(KEYS.cachePrefix) ? readJSON<Cached<unknown>>(k) : null;
    if (!c || Date.now() - c.at > CACHE_MAX_AGE) removeKey(k);
  }
}

/** Deletes every stored copy (they are downloaded again when needed). */
export function clearRemoteCache() {
  for (const k of keysWithPrefix(KEYS.cacheRoot)) removeKey(k);
}

function setState<T>(e: Entry<T>, patch: Partial<RemoteState<T>>) {
  e.state = { ...e.state, ...patch };
  for (const fn of e.subs) fn();
}

function refresh<T>(key: string, e: Entry<T>, force = false) {
  if (e.inflight || document.visibilityState === 'hidden') return;
  if (!force && Date.now() - e.fetchedAt < e.ttl) return;
  e.inflight = true;
  setState(e, { loading: true });
  e.fetcher().then(
    (data) => {
      e.inflight = false;
      e.fetchedAt = Date.now();
      writeJSON(KEYS.cachePrefix + key, { at: e.fetchedAt, data } satisfies Cached<T>);
      setState(e, { data, error: undefined, loading: false });
    },
    (err: unknown) => {
      e.inflight = false;
      setState(e, { error: err instanceof Error ? err.message : String(err), loading: false });
    },
  );
}

function entryFor<T>(key: string, fetcher: () => Promise<T>, ttl: number, isValid?: Validator<T>): Entry<T> {
  let e = entries.get(key) as Entry<T> | undefined;
  if (!e) {
    const stored = readJSON<Cached<unknown>>(KEYS.cachePrefix + key);
    // A copy that doesn't look right is treated as missing (and downloaded again).
    const cached = stored && (!isValid || isValid(stored.data)) ? (stored as Cached<T>) : null;
    e = {
      state: { data: cached?.data, loading: !cached },
      fetchedAt: cached?.at ?? 0,
      fetcher,
      ttl,
      inflight: false,
      subs: new Set(),
    };
    entries.set(key, e as Entry<unknown>);
    if (entries.size === 1) pruneCache();
  }
  return e;
}

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  for (const [key, e] of entries) if (e.subs.size) refresh(key, e);
}

let listening = false;

function watch<T>(key: string, e: Entry<T>, fn: () => void) {
  if (!listening) {
    document.addEventListener('visibilitychange', onVisible);
    listening = true;
  }
  if (e.subs.size === 0) {
    refresh(key, e);
    e.timer = setInterval(() => refresh(key, e), Math.min(e.ttl, 15 * 60_000));
  }
  e.subs.add(fn);
  return () => {
    e.subs.delete(fn);
    if (e.subs.size === 0) clearInterval(e.timer);
  };
}

const noop = () => {};

/**
 * Data from `fetcher`, cached under `key` for `ttlMs`. A null key means there's
 * nothing to load (e.g. no location chosen yet). `isValid` checks stored copies.
 */
export function useRemote<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  ttlMs: number,
  isValid?: Validator<T>,
): RemoteState<T> {
  const entry = key ? entryFor(key, fetcher, ttlMs, isValid) : null;
  // The latest fetcher is used for the next refresh (it may close over new values).
  useEffect(() => {
    if (entry) entry.fetcher = fetcher;
  });
  const subscribe = useCallback((fn: () => void) => (key && entry ? watch(key, entry, fn) : noop), [key, entry]);
  return useSyncExternalStore(subscribe, () => (entry ? entry.state : IDLE));
}

/** For tests. */
export function resetRemote() {
  for (const e of entries.values()) clearInterval(e.timer);
  entries.clear();
}
