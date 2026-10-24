// Each person's notification choices, resolved against the household defaults.
// Shared by the app (Settings) and the notifier, so both read them the same way.
import type { ActivityKind, Household, PersonalNotify } from './types';

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['shopping', 'event', 'task', 'menu', 'expense', 'date', 'note'];

/** Hours offered for the morning summary. */
export const DAILY_HOURS: readonly number[] = [6, 7, 8, 9, 10];

export interface ResolvedNotify {
  activity: Record<ActivityKind, boolean>;
  reminders: boolean;
  keyDates: boolean;
  daily: boolean;
  dailyHour: number;
}

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

function hour(v: unknown, fallback: number) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
}

/**
 * A person's choices with every gap filled: their own value if they set one,
 * else the household's (from earlier versions), else on (summary at 08:00).
 */
export function resolveNotify(household: Pick<Household, 'notify'>, personal?: PersonalNotify | null): ResolvedNotify {
  const h = household.notify;
  const activityDefault = bool(h?.activity, true);
  const mine = personal?.activity;
  const activity = Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, bool(mine?.[k], activityDefault)])) as Record<
    ActivityKind,
    boolean
  >;
  return {
    activity,
    reminders: bool(personal?.reminders, true),
    keyDates: bool(personal?.keyDates, true),
    daily: bool(personal?.daily, bool(h?.dailySummary, true)),
    dailyHour: hour(personal?.dailyHour, hour(h?.dailyHour, 8)),
  };
}
