import { describe, expect, it } from 'vitest';
import { ACTIVITY_KINDS, resolveNotify } from './notify';

const everyKind = (on: boolean) => Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, on]));

describe('resolveNotify', () => {
  it('turns everything on by default, with the summary at 08:00', () => {
    expect(resolveNotify({})).toEqual({
      activity: everyKind(true),
      reminders: true,
      keyDates: true,
      daily: true,
      dailyHour: 8,
    });
  });

  it('starts from the household settings of earlier versions', () => {
    const n = resolveNotify({ notify: { activity: false, dailySummary: false, dailyHour: 7 } });
    expect(n.activity).toEqual(everyKind(false));
    expect(n.daily).toBe(false);
    expect(n.dailyHour).toBe(7);
  });

  it("applies the person's own choices over the household's", () => {
    const n = resolveNotify(
      { notify: { activity: false, dailySummary: true, dailyHour: 8 } },
      { activity: { event: true }, reminders: false, daily: false, dailyHour: 9 },
    );
    expect(n.activity.event).toBe(true);
    expect(n.activity.shopping).toBe(false);
    expect(n.reminders).toBe(false);
    expect(n.keyDates).toBe(true);
    expect(n.daily).toBe(false);
    expect(n.dailyHour).toBe(9);
  });

  it('ignores invalid values', () => {
    const n = resolveNotify(
      { notify: { activity: true, dailySummary: true, dailyHour: 99 } },
      // biome-ignore lint/suspicious/noExplicitAny: stored data could be anything
      { activity: { shopping: 'no' as any }, dailyHour: 7.5 },
    );
    expect(n.activity.shopping).toBe(true);
    expect(n.dailyHour).toBe(8);
  });
});
