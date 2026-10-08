import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { loadMessages } from '../i18n/messages';
import { durationEditorText, formatDuration, parseDuration } from './durations';

const messages = await loadMessages('en');
/** Writes a number in American English. */
const english = (value: number) => new Intl.NumberFormat('en-US').format(value);

describe('formatDuration', () => {
  it.each([
    [7, '7 h'],
    [1.25, '1 h 15'],
    [0.75, '45 min'],
    [0, '0 h'],
    [1234.5, '1,234 h 30'],
  ])('writes %d hours as %s', (hours, expected) => {
    expect(formatDuration(hours, messages, english)).toBe(expected);
  });
});

describe('parseDuration', () => {
  it.each([
    ['14', 14],
    ['14h', 14],
    ['1,5', 1.5],
    ['1.25 h', 1.25],
    ['1 h 30', 1.5],
    ['1h45min', 1.75],
    ['1:15', 1.25],
    ['45 min', 0.75],
    ['90m', 1.5],
    ['2d', 18],
    ['0.5d', 4.5],
    ['1 h 20', 1.25],
    ['10 min', 0.25],
    ['0', 0],
    ['-3', null],
    ['soon', null],
    ['1e3', null],
    ['', null],
    ['1'.repeat(80), null],
  ])('reads %j as %s hours, to the nearest quarter hour', (text, expected) => {
    expect(parseDuration(text, 9)).toBe(expected);
  });

  it('reads back every duration the editor writes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400_000 }), (quarters) => {
        const hours = quarters / 4;
        expect(parseDuration(durationEditorText(hours), 9)).toBe(hours);
      }),
    );
  });

  it('writes whole hours, minutes alone, and hours with minutes for the editor', () => {
    expect(durationEditorText(3)).toBe('3 h');
    expect(durationEditorText(0.5)).toBe('30 min');
    expect(durationEditorText(1.25)).toBe('1 h 15');
    expect(durationEditorText(0)).toBe('0 h');
  });
});
