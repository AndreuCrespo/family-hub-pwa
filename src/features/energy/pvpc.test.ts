import { describe, expect, it } from 'vitest';
import { cheapestWindow, hourIndex, hourLabel, isPvpcDay, parsePvpc, priceLevel, priceStats } from './pvpc';

/** REE's answer for a day: one value per hour, with the Madrid offset of that hour. */
function reeDay(entries: [time: string, offset: '+01:00' | '+02:00', eurPerMwh: number][], date: string) {
  return {
    included: [
      { type: 'Precio mercado spot', attributes: { values: [] } },
      {
        type: 'PVPC',
        attributes: {
          values: entries.map(([time, offset, value]) => ({ value, datetime: `${date}T${time}:00.000${offset}` })),
        },
      },
    ],
  };
}

describe('parsePvpc', () => {
  it('keeps the 25 hours of the day the clocks go back', () => {
    // 2026-10-25: 02:00–03:00 happens twice in Madrid.
    const entries: [string, '+01:00' | '+02:00', number][] = [];
    for (let h = 0; h <= 2; h++) entries.push([`${String(h).padStart(2, '0')}:00`, '+02:00', 100 + h]);
    for (let h = 2; h <= 23; h++) entries.push([`${String(h).padStart(2, '0')}:00`, '+01:00', 200 + h]);
    const day = parsePvpc('2026-10-25', reeDay(entries, '2026-10-25'));
    expect(day?.hours).toHaveLength(25);
    // Every hour starts an hour after the previous one, with no duplicates.
    const starts = day?.hours.map((h) => h.start) ?? [];
    expect(new Set(starts).size).toBe(25);
    for (let i = 1; i < starts.length; i++) expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBe(3_600_000);
    // The repeated hour is labelled 2 both times in Madrid.
    expect(day?.hours.slice(2, 4).map((h) => hourLabel(h, 'Europe/Madrid'))).toEqual([2, 2]);
  });

  it('labels hours in the household time zone (Canary Islands are an hour behind)', () => {
    const day = parsePvpc('2026-06-01', reeDay([['10:00', '+02:00', 150]], '2026-06-01'));
    const hour = day?.hours[0];
    expect(hour && hourLabel(hour, 'Europe/Madrid')).toBe(10);
    expect(hour && hourLabel(hour, 'Atlantic/Canary')).toBe(9);
  });

  it('converts €/MWh to €/kWh and ignores other days', () => {
    const json = reeDay([['00:00', '+02:00', 123]], '2026-06-01');
    json.included[1]?.attributes.values.push({ value: 99, datetime: '2026-06-02T00:00:00.000+02:00' });
    expect(parsePvpc('2026-06-01', json)?.hours.map((h) => h.price)).toEqual([0.123]);
  });

  it('returns null when there is no PVPC series yet', () => {
    expect(parsePvpc('2026-06-01', { included: [] })).toBeNull();
  });
});

describe('prices', () => {
  const day = parsePvpc(
    '2026-06-01',
    reeDay(
      [0.2, 0.1, 0.05, 0.3, 0.25, 0.06].map((p, h) => [`0${h}:00`, '+02:00', p * 1000] as [string, '+02:00', number]),
      '2026-06-01',
    ),
  );
  if (!day) throw new Error('fixture');

  it('finds the current hour', () => {
    const second = day.hours[1];
    expect(second && hourIndex(day, second.start + 59 * 60_000)).toBe(1);
    expect(hourIndex(day, (day.hours[0]?.start ?? 0) - 1)).toBe(-1);
  });

  it('finds the cheapest run of hours from now on', () => {
    expect(cheapestWindow(day, 2)?.start).toBe(day.hours[1]);
    expect(cheapestWindow(day, 2, 3)?.start).toBe(day.hours[4]);
    expect(cheapestWindow(day, 9)).toBeNull();
  });

  it('classifies prices by thirds', () => {
    const s = priceStats(day);
    expect(s.min).toBe(0.05);
    expect(s.max).toBe(0.3);
    expect(priceLevel(0.05, s)).toBe('low');
    expect(priceLevel(0.3, s)).toBe('high');
  });
});

describe('stored copies', () => {
  it('accepts the current format and rejects the one of earlier versions', () => {
    expect(isPvpcDay(null)).toBe(true);
    expect(isPvpcDay({ date: '2026-10-24', hours: [{ start: 1_792_800_000_000, price: 0.1 }] })).toBe(true);
    // Before 0.1.0 hours were { hour, price }.
    expect(isPvpcDay({ date: '2026-10-24', hours: [{ hour: 9, price: 0.1 }] })).toBe(false);
    expect(isPvpcDay({ date: '2026-10-24' })).toBe(false);
    expect(isPvpcDay('nope')).toBe(false);
  });
});
