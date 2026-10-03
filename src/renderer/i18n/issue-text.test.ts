import { describe, expect, it } from 'vitest';
import english from '../locales/en.json';
import { issueText, repairText } from './issue-text';

describe('issueText', () => {
  it('places a problem of a table on its row and column, in words', () => {
    expect(issueText(english, { path: 'rows[4].start', code: 'START_DIFFERS' })).toBe(
      `Row 4, start: ${english.issues.START_DIFFERS}`,
    );
    expect(issueText(english, { path: 'rows[2]', code: 'EXTRA_CELLS' })).toBe(
      `Row 2: ${english.issues.EXTRA_CELLS}`,
    );
    expect(issueText(english, { path: 'columns[3]', code: 'UNKNOWN_COLUMN' })).toBe(
      `Column 3: ${english.issues.UNKNOWN_COLUMN}`,
    );
  });

  it('counts tasks, links and tags of a project from 1, and names nested fields', () => {
    expect(
      issueText(english, { path: 'tasks[0].segments[1].durationHours', code: 'INVALID_DURATION' }),
    ).toBe(`Task 1, blocks 2, duration: ${english.issues.INVALID_DURATION}`);
    expect(issueText(english, { path: 'dependencies[2]', code: 'DEPENDENCY_CYCLE' })).toBe(
      `Link 3: ${english.issues.DEPENDENCY_CYCLE}`,
    );
    expect(issueText(english, { path: 'tags[0].color', code: 'INVALID_COLOR' })).toBe(
      `Tag 1, color: ${english.issues.INVALID_COLOR}`,
    );
  });

  it('names a field outside any list, and gives the reason alone for a problem of the whole file', () => {
    expect(
      issueText(english, { path: 'calendar.workingWeekdays', code: 'NO_WORKING_WEEKDAY' }),
    ).toBe(`calendar, working days: ${english.issues.NO_WORKING_WEEKDAY}`);
    expect(issueText(english, { path: '', code: 'TOO_MANY_ISSUES' })).toBe(
      english.issues.TOO_MANY_ISSUES,
    );
  });

  it('keeps the written name of an unknown field and gives a general reason for an unknown code', () => {
    expect(issueText(english, { path: 'surprise', code: 'NEW_CODE' })).toBe(
      `surprise: ${english.issuePlaces.unknownReason}`,
    );
    expect(issueText(english, { path: '', code: 'toString' })).toBe(
      english.issuePlaces.unknownReason,
    );
  });

  it('names a list that is not a place as a field, counted from 1, and a malformed entry by its name alone', () => {
    expect(issueText(english, { path: 'segments[1].gapDaysBefore', code: 'OUT_OF_RANGE' })).toBe(
      `blocks 2, days before the block: ${english.issues.OUT_OF_RANGE}`,
    );
    expect(issueText(english, { path: 'tasks[x].name', code: 'TOO_LONG' })).toBe(
      `tasks, name: ${english.issues.TOO_LONG}`,
    );
  });

  it('reads a forged path naming a property every object has as a field, never as a place', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(issueText(english, { path: `${name}[0]`, code: 'EMPTY_TEXT' })).toBe(
        `${name} 1: ${english.issues.EMPTY_TEXT}`,
      );
    }
  });

  it('never repeats a forged path longer than a real one', () => {
    expect(issueText(english, { path: 'x'.repeat(10_000), code: 'TOO_LONG' })).toBe(
      english.issues.TOO_LONG,
    );
  });

  it('has a distinct, non-empty text for every problem and adjustment', () => {
    for (const texts of [english.issues, english.repairCodes]) {
      const values = Object.values(texts);
      expect(values.every((value) => value.trim().length > 0)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

describe('repairText', () => {
  it('names the task an adjustment concerns while it still exists', () => {
    const names = new Map([['a', 'Write report']]);
    const name = (id: string) => names.get(id) ?? null;
    expect(repairText(english, { code: 'TAG_CLEARED', id: 'a' }, name)).toBe(
      `Task “Write report”: ${english.repairCodes.TAG_CLEARED}`,
    );
    expect(repairText(english, { code: 'DEPENDENCY_REMOVED', id: 'a-b' }, name)).toBe(
      english.repairCodes.DEPENDENCY_REMOVED,
    );
  });

  it('gives the reason alone for an adjustment of a task that no longer exists', () => {
    expect(repairText(english, { code: 'TAG_CLEARED', id: 'gone' }, () => null)).toBe(
      english.repairCodes.TAG_CLEARED,
    );
  });
});
