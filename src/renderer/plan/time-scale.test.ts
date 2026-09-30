import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { at } from '../../core/testing/civil-time';
import { MIN_PROJECT_HOUR, END_PROJECT_HOUR } from '../../core/time';
import {
  buildScaleTicks,
  createScaleLabels,
  nextUnit,
  pixelsPerHour,
  snapHours,
  zoomedScrollLeft,
  startOfUnit,
  ZOOM_LEVELS,
} from './time-scale';

const LABELS = createScaleLabels('en-US');

describe('buildScaleTicks', () => {
  it('shows days over hours at the hour zoom', () => {
    const ticks = buildScaleTicks('hour', at(2026, 10, 5, 22), at(2026, 10, 6, 2), LABELS);
    expect(ticks.upper.map((tick) => tick.label)).toEqual(['Mon, Oct 5, 2026', 'Tue, Oct 6, 2026']);
    expect(ticks.lower.map((tick) => tick.label)).toEqual(['10 PM', '11 PM', '12 AM', '1 AM']);
  });

  it('shows months over days at the day zoom', () => {
    const ticks = buildScaleTicks('day', at(2026, 10, 30), at(2026, 11, 2), LABELS);
    expect(ticks.upper.map((tick) => tick.label)).toEqual(['October 2026', 'November 2026']);
    expect(ticks.lower.map((tick) => tick.label)).toEqual(['30', '31', '1']);
  });

  it('shows months over weeks starting on Monday at the week zoom', () => {
    const ticks = buildScaleTicks('week', at(2026, 10, 7), at(2026, 10, 20), LABELS);
    expect(ticks.lower.map((tick) => [tick.start, tick.label])).toEqual([
      [at(2026, 10, 5), '5'],
      [at(2026, 10, 12), '12'],
      [at(2026, 10, 19), '19'],
    ]);
  });

  it('shows years over months at the month zoom', () => {
    const ticks = buildScaleTicks('month', at(2026, 12, 15), at(2027, 2, 1), LABELS);
    expect(ticks.upper.map((tick) => tick.label)).toEqual(['2026', '2027']);
    expect(ticks.lower.map((tick) => tick.label)).toEqual(['Dec', 'Jan']);
  });

  it('covers the interval with periods that follow one another without gap', () => {
    const hour = fc.integer({ min: MIN_PROJECT_HOUR, max: END_PROJECT_HOUR - 2_000 });
    fc.assert(
      fc.property(
        hour,
        fc.integer({ min: 1, max: 1_500 }),
        fc.constantFrom(...ZOOM_LEVELS),
        (from, length, zoom) => {
          const ticks = buildScaleTicks(zoom, from, from + length, LABELS);
          for (const row of [ticks.upper, ticks.lower]) {
            expect(row[0]?.start).toBeLessThanOrEqual(from);
            expect(row.at(-1)?.end).toBeGreaterThanOrEqual(from + length);
            row.slice(1).forEach((tick, index) => {
              expect(tick.start).toBe(row[index]?.end);
            });
          }
        },
      ),
    );
  });
});

describe('periods', () => {
  it('finds the start of each kind of period', () => {
    const moment = at(2026, 10, 8, 15);
    expect(startOfUnit('hour', moment)).toBe(moment);
    expect(startOfUnit('day', moment)).toBe(at(2026, 10, 8));
    expect(startOfUnit('week', moment)).toBe(at(2026, 10, 5));
    expect(startOfUnit('week', at(2026, 10, 11, 23))).toBe(at(2026, 10, 5));
    expect(startOfUnit('month', moment)).toBe(at(2026, 10, 1));
    expect(startOfUnit('year', moment)).toBe(at(2026, 1, 1));
    expect(nextUnit('month', at(2026, 12, 1))).toBe(at(2027, 1, 1));
    expect(nextUnit('year', at(2026, 1, 1))).toBe(at(2027, 1, 1));
  });
});

describe('zoom levels', () => {
  it('gets narrower from the hour to the month, and aligns bars to the hour only at the hour zoom', () => {
    const widths = ZOOM_LEVELS.map(pixelsPerHour);
    expect([...widths].sort((left, right) => right - left)).toEqual(widths);
    expect(ZOOM_LEVELS.map(snapHours)).toEqual([1, 24, 24, 24]);
  });
});

describe('zoomedScrollLeft', () => {
  it('keeps the instant in the middle of the view', () => {
    const left = 1_000;
    const width = 600;
    const middleHour = (left + width / 2) / pixelsPerHour('day');
    const zoomed = zoomedScrollLeft(left, width, 'day', 'hour');
    expect((zoomed + width / 2) / pixelsPerHour('hour')).toBeCloseTo(middleHour);
    expect(zoomedScrollLeft(0, width, 'hour', 'month')).toBe(0);
  });
});
