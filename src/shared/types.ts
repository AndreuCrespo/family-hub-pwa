// Data model shared by the app and the notifier.
// All dates are local 'YYYY-MM-DD' strings and times are 'HH:mm', in the
// household's time zone (avoids trouble with daylight-saving changes).
import type { DateStr, TimeStr } from './dates';

/** UI / notification language. */
export type Lang = 'es' | 'en';

export type MemberKind = 'adult' | 'child';

export interface Member {
  id: string;
  name: string;
  color: string;
  kind: MemberKind;
  uid?: string | null; // linked account (adults only)
}

export interface Household {
  id: string;
  name: string;
  /** Accounts in the household. One may have no `members` entry yet (joined, not claimed). */
  memberUids: string[];
  members: Member[];
  timezone: string;
  location?: { name: string; lat: number; lon: number } | null;
  notify?: NotifySettings;
  /** Invite code each account joined with, by uid (households/{id}/invites/{code}). */
  joinedWith?: Record<string, string>;
  createdAt: number;
}

/** households/{hid}/invites/{code}: a link to join the household, valid until `expiresAt`. */
export interface Invite {
  /** The invite code (document id). */
  id: string;
  householdName: string;
  createdBy: string; // uid
  createdByName: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Household-wide notification settings from earlier versions. Each person's
 * own choices (PersonalNotify) take precedence; these are only their defaults.
 */
export interface NotifySettings {
  dailySummary: boolean;
  dailyHour: number; // local hour of the daily summary
  activity: boolean; // "X added milk to the shopping list"
}

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Recurrence {
  freq: Freq;
  interval: number;
  byWeekday?: number[]; // 0 = Monday … 6 = Sunday
  until?: DateStr | null;
}

export interface CalEvent {
  id: string;
  title: string;
  date: DateStr;
  endDate?: DateStr | null; // inclusive, for multi-day events
  startTime?: TimeStr | null; // null => all day
  endTime?: TimeStr | null;
  memberIds: string[];
  recurrence?: Recurrence | null;
  exdates?: DateStr[];
  reminderMins?: number | null; // minutes before (all-day events: relative to 09:00), see reminders.ts
  location?: string;
  notes?: string;
  createdBy?: string;
  updatedAt?: number;
}

export interface ShoppingItem {
  id: string;
  name: string;
  done: boolean;
  addedBy?: string;
  createdAt: number;
  doneAt?: number | null;
}

export type RepeatUnit = 'day' | 'week' | 'month';

export interface Task {
  id: string;
  title: string;
  memberIds: string[];
  due?: DateStr | null;
  repeat?: { every: number; unit: RepeatUnit } | null;
  done: boolean;
  lastDoneAt?: number | null;
  lastDoneBy?: string | null;
  notes?: string;
  createdAt: number;
}

export interface MenuDay {
  id: DateStr;
  lunch?: string;
  dinner?: string;
}

export type KeyDateKind = 'birthday' | 'car' | 'insurance' | 'bill' | 'health' | 'school' | 'other';

export interface KeyDate {
  id: string;
  title: string;
  kind: KeyDateKind;
  date: DateStr; // for birthdays, the date of birth
  repeat: 'none' | 'monthly' | 'yearly';
  remindDays: number;
  memberIds?: string[];
  amount?: number | null; // cents
  notes?: string;
}

export interface Expense {
  id: string;
  description: string;
  amount: number; // cents
  paidBy: string; // member id
  splitAmong: string[]; // member ids (for 'settle', the one who receives)
  date: DateStr;
  category: string;
  kind: 'expense' | 'settle';
  createdBy?: string;
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  color: string;
  updatedAt: number;
  updatedBy?: string;
}

/** households/{hid}/devices/{first 12 bytes of sha256(endpoint), hex}: one browser with push on. */
export interface Device {
  id: string;
  uid: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  ua: string;
  createdAt: number;
  /** Language for this device's notifications (missing or unknown ⇒ 'es'). */
  lang?: Lang;
}

export type ActivityKind = 'shopping' | 'event' | 'task' | 'note' | 'expense' | 'date' | 'menu';

/**
 * What one person wants to be notified about (prefs/{uid}.notify). Missing
 * fields fall back to the household defaults (see shared/notify.ts).
 */
export interface PersonalNotify {
  /** What the others add, by kind ("Sam added milk"). */
  activity?: Partial<Record<ActivityKind, boolean>>;
  /** Event reminders. */
  reminders?: boolean;
  /** Upcoming key dates (birthdays, renewals…). */
  keyDates?: boolean;
  /** Morning summary. */
  daily?: boolean;
  /** Local hour of the morning summary (0–23). */
  dailyHour?: number;
}

/** households/{hid}/activity/{id}: one thing someone added, written by the app and notified by the server. */
export interface Activity {
  id: string;
  actorUid: string;
  actorName: string;
  kind: ActivityKind;
  text: string; // e.g. "milk"
  createdAt: number;
  notified: boolean;
}
