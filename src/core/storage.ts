// Safe localStorage access. Storage can be unavailable (private mode, blocked
// site data) or full, and the app has to keep working either way.

/** Every key the app keeps in localStorage. */
export const KEYS = {
  lang: 'casa-lang',
  theme: 'casa-theme',
  calendarView: 'casa-calview',
  /** Household the user last entered (when they belong to more than one). */
  household: 'casa-hid',
  /** Invite opened before signing in: { hid, code }. */
  invite: 'casa-invite',
  /** Prefix of every copy of remote data (weather, electricity prices), of any format. */
  cacheRoot: 'casa-cache:',
  /**
   * Prefix of the copies in the current format. Change the version when the
   * shape of cached data changes: older copies are then ignored and deleted.
   */
  cachePrefix: 'casa-cache:v2:',
  /** Prefix of demo mode data. */
  demoPrefix: 'casa-demo:',
} as const;

export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Unavailable or full: the value just isn't remembered.
  }
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to remove.
  }
}

export function keysWithPrefix(prefix: string): string[] {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
}

export function readJSON<T>(key: string): T | null {
  const raw = readString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJSON(key: string, value: unknown) {
  writeString(key, JSON.stringify(value));
}

/** Reads a value and returns it only if it's one of the allowed options. */
export function readChoice<T extends string>(key: string, options: readonly T[], fallback: T): T {
  const v = readString(key);
  return (options as readonly string[]).includes(v ?? '') ? (v as T) : fallback;
}
