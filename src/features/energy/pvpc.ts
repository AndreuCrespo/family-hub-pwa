// Hourly PVPC electricity price (Spain's regulated tariff) from Red Eléctrica's public API.
import { useApp } from '../../core/app';
import { useNow } from '../../core/clock';
import { decimal } from '../../core/format';
import { useRemote } from '../../core/remote';
import { addDays, todayIn, zonedParts } from '../../shared/dates';

/** Prices are set per hour of Spain's peninsular time. */
const PVPC_TZ = 'Europe/Madrid';

export interface PvpcHour {
  /** Start of the hour (ms). */
  start: number;
  /** €/kWh */
  price: number;
}

export interface PvpcDay {
  date: string;
  hours: PvpcHour[];
}

interface ReeResponse {
  included?: { type: string; attributes: { values: { value: number; datetime: string }[] } }[];
}

/** Parses REE's answer for one day (23, 24 or 25 hours, depending on clock changes). */
export function parsePvpc(date: string, json: ReeResponse): PvpcDay | null {
  const serie = json.included?.find((x) => x.type === 'PVPC');
  if (!serie) return null;
  const hours = serie.attributes.values
    .map((v) => ({ start: Date.parse(v.datetime), price: v.value / 1000 }))
    .filter((h) => Number.isFinite(h.start) && todayIn(PVPC_TZ, h.start) === date)
    .sort((a, b) => a.start - b.start);
  return hours.length ? { date, hours } : null;
}

async function fetchPvpc(date: string): Promise<PvpcDay | null> {
  const q = new URLSearchParams({ start_date: `${date}T00:00`, end_date: `${date}T23:59`, time_trunc: 'hour' });
  const r = await fetch(`https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?${q}`);
  if (!r.ok) {
    if (r.status === 404 || r.status === 500) return null; // not published yet
    throw new Error(`REE ${r.status}`);
  }
  return parsePvpc(date, (await r.json()) as ReeResponse);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A stored copy of a day (or null: not published yet) in the current format. */
export function isPvpcDay(v: unknown): v is PvpcDay | null {
  if (v === null) return true;
  if (!isRecord(v) || typeof v.date !== 'string' || !Array.isArray(v.hours)) return false;
  return v.hours.every(
    (h: unknown) => isRecord(h) && Number.isFinite(h.start) && typeof h.price === 'number' && Number.isFinite(h.price),
  );
}

/** Index of the hour containing `now`, or -1. */
export function hourIndex(day: PvpcDay, now: number) {
  return day.hours.findIndex((h) => now >= h.start && now < h.start + 3_600_000);
}

/** Local hour (in the household's time zone) when an hour starts. */
export const hourLabel = (h: PvpcHour, tz: string) => zonedParts(h.start, tz).hour;

export function usePvpc() {
  const { tz } = useApp();
  const now = useNow();
  const today = todayIn(PVPC_TZ, now);
  const madridHour = zonedParts(now, PVPC_TZ).hour;
  const todayData = useRemote(`pvpc:${today}`, () => fetchPvpc(today), 6 * 3_600_000, isPvpcDay);
  // Tomorrow's prices are published around 20:15 (peninsular time): ask again every hour until then.
  const tomorrow = addDays(today, 1);
  const tomorrowData = useRemote(
    madridHour >= 20 ? `pvpc:${tomorrow}` : null,
    () => fetchPvpc(tomorrow),
    3_600_000,
    isPvpcDay,
  );
  const data = todayData.data ?? null;
  return {
    tz,
    now,
    data,
    current: data ? hourIndex(data, now) : -1,
    tomorrow: tomorrowData.data ?? null,
    loading: todayData.loading,
    error: todayData.error,
  };
}

export interface PriceStats {
  min: number;
  max: number;
  avg: number;
  p33: number;
  p66: number;
}

export function priceStats(day: PvpcDay): PriceStats {
  const ps = day.hours.map((h) => h.price);
  const sorted = [...ps].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  return {
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    avg: ps.reduce((a, b) => a + b, 0) / (ps.length || 1),
    p33: at(1 / 3),
    p66: at(2 / 3),
  };
}

export type PriceLevel = 'low' | 'mid' | 'high';

export function priceLevel(price: number, s: Pick<PriceStats, 'p33' | 'p66'>): PriceLevel {
  return price <= s.p33 ? 'low' : price <= s.p66 ? 'mid' : 'high';
}

/** Cheapest run of `len` consecutive hours starting at index `from` or later. */
export function cheapestWindow(day: PvpcDay, len: number, from = 0): { start: PvpcHour; avg: number } | null {
  let best: { start: PvpcHour; avg: number } | null = null;
  for (let i = Math.max(0, from); i + len <= day.hours.length; i++) {
    const run = day.hours.slice(i, i + len);
    const first = run[0];
    if (!first) continue;
    const avg = run.reduce((a, h) => a + h.price, 0) / len;
    if (!best || avg < best.avg) best = { start: first, avg };
  }
  return best;
}

export const kwh = (p: number) => `${decimal(p, 3)} €/kWh`;
