// Data access for one household. Two implementations share this interface:
// Firestore (real, synced) and localStorage (demo mode).
import type {
  Activity,
  CalEvent,
  Device,
  Expense,
  Household,
  Invite,
  KeyDate,
  MenuDay,
  Note,
  PersonalNotify,
  ShoppingItem,
  Task,
} from '../../shared/types';

/** Home screen layout of one person (prefs/{uid}). */
export interface Prefs {
  id: string;
  dashboard?: { order?: string[]; hidden?: string[] };
  /** Which notifications this person gets. */
  notify?: PersonalNotify;
  updatedAt?: number;
}

/** How often each shopping item was added (meta/shopping), for suggestions. */
export interface ShoppingMeta {
  id: string;
  freq?: Record<string, number>;
}

/** Every subcollection of a household and the type of its documents. */
export interface Collections {
  events: CalEvent;
  shopping: ShoppingItem;
  tasks: Task;
  menu: MenuDay;
  dates: KeyDate;
  expenses: Expense;
  notes: Note;
  invites: Invite;
  prefs: Prefs;
  meta: ShoppingMeta;
  devices: Device;
  activity: Activity;
}

export type CollectionName = keyof Collections;
/** Collections the app lists; the rest are read one document at a time, or not at all. */
export type ListedCollection = 'events' | 'shopping' | 'tasks' | 'menu' | 'dates' | 'expenses' | 'notes' | 'invites';
export type DocData<K extends CollectionName> = Omit<Collections[K], 'id'>;

/** Range of document ids (inclusive), e.g. dates of the weekly menu. */
export interface IdRange {
  from?: string;
  to?: string;
}

export type Unsubscribe = () => void;
type OnError = (e: Error) => void;

export interface Backend {
  readonly householdId: string;
  watch<K extends ListedCollection>(
    coll: K,
    cb: (items: Collections[K][]) => void,
    onError: OnError,
    range?: IdRange,
  ): Unsubscribe;
  watchDoc<K extends CollectionName>(
    coll: K,
    id: string,
    cb: (doc: Collections[K] | null) => void,
    onError: OnError,
  ): Unsubscribe;
  watchHousehold(cb: (h: Household | null) => void, onError: OnError): Unsubscribe;
  updateHousehold(data: Partial<Omit<Household, 'id'>>): Promise<void>;
  newId(): string;
  /*
   * Writes are optimistic: they show up at once (also offline) and the returned
   * promise settles when the server confirms. Failures are reported to the user
   * by the backend, so callers only await when they need the outcome.
   */
  /** Creates a document and returns its id. `quiet`: failures are only logged. */
  add<K extends CollectionName>(coll: K, data: DocData<K>, opts?: { quiet?: boolean }): string;
  set<K extends CollectionName>(coll: K, id: string, data: DocData<K>): Promise<void>;
  /** Writes only the given fields, creating the document if needed (nested maps are merged). */
  merge<K extends CollectionName>(coll: K, id: string, data: Partial<DocData<K>>): Promise<void>;
  update<K extends CollectionName>(coll: K, id: string, data: Partial<DocData<K>>): Promise<void>;
  remove(coll: CollectionName, id: string): Promise<void>;
}
