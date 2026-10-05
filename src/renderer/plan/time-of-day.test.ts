import { describe, expect, it } from 'vitest';
import { formatTimeOfDay, parseTimeOfDay } from './time-of-day';

describe('time of day', () => {
  it('writes hours as "HH:MM", the end of the day as midnight', () => {
    expect([0, 8.25, 13.5, 23.75, 24].map(formatTimeOfDay)).toEqual([
      '00:00',
      '08:15',
      '13:30',
      '23:45',
      '00:00',
    ]);
  });

  it('reads a quarter-hour time, and nothing else', () => {
    expect([' 08:15 ', '00:00', '23:45'].map(parseTimeOfDay)).toEqual([8.25, 0, 23.75]);
    for (const text of ['8:15', '08:10', '08:60', '08:75', '24:00', '', 'noon', '08:15:00']) {
      expect(parseTimeOfDay(text)).toBeNull();
    }
  });
});
