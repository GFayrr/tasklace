import { describe, expect, it } from 'vitest';
import { MAX_PROJECT_NAME_LENGTH } from '../core/limits';
import { toProjectHour } from '../core/time';
import {
  fileNameForProject,
  localProjectHour,
  projectNameFromPath,
  withExtension,
} from './project-names';

const FALLBACK = 'Untitled project';

describe('projectNameFromPath', () => {
  it.each([
    ['/projects/Plan 2027.csv', 'Plan 2027'],
    ['/projects/archive.v2.json', 'archive.v2'],
    ['/projects/Été\u0007.csv', 'Été'],
    ['/projects/.csv', '.csv'],
    ['/projects/   .json', FALLBACK],
  ])('names %j %j', (path, expected) => {
    expect(projectNameFromPath(path, FALLBACK)).toBe(expected);
  });

  it('keeps a name within the length of a project name, counting characters rather than code units', () => {
    const name = projectNameFromPath(
      `/p/${'😀'.repeat(MAX_PROJECT_NAME_LENGTH + 5)}.csv`,
      FALLBACK,
    );
    expect(Array.from(name)).toHaveLength(MAX_PROJECT_NAME_LENGTH);
  });
});

describe('localProjectHour', () => {
  it('reads the local date and hour of a moment', () => {
    const moment = new Date(2026, 8, 30, 14, 35);
    const expected = toProjectHour({ year: 2026, month: 9, day: 30, hour: 14 });
    expect(expected.ok && localProjectHour(moment, 0)).toBe(expected.ok && expected.value);
  });

  it('falls back outside the supported years', () => {
    expect(localProjectHour(new Date(1999, 0, 1), 42)).toBe(42);
  });
});

describe('fileNameForProject', () => {
  it.each([
    ['Launch plan', 'Launch plan.csv'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a b c d e f g h i j.csv'],
    ['  Spaced.. ', 'Spaced.csv'],
    ['...', 'Untitled project.csv'],
    ['', 'Untitled project.csv'],
    ['CON', 'CON_.csv'],
    ['lpt1', 'lpt1_.csv'],
    ['CON.backup', 'CON_.backup.csv'],
    ['nul .v2', 'nul _.v2.csv'],
    ['com²', 'com²_.csv'],
    ['Console', 'Console.csv'],
    ['\u0001\u0002', 'Untitled project.csv'],
  ])('writes %j as %j', (name, expected) => {
    expect(fileNameForProject(name, 'csv', 'Untitled project')).toBe(expected);
  });

  it('keeps the name within the length of a project name, counting characters', () => {
    const name = fileNameForProject('é'.repeat(MAX_PROJECT_NAME_LENGTH + 5), 'json', 'x');
    expect(name).toBe(`${'é'.repeat(MAX_PROJECT_NAME_LENGTH)}.json`);
  });
});

describe('withExtension', () => {
  it('adds the extension only when the path does not end with it, whatever its case', () => {
    expect(withExtension('/tmp/plan', 'csv')).toBe('/tmp/plan.csv');
    expect(withExtension('/tmp/plan.CSV', 'csv')).toBe('/tmp/plan.CSV');
    expect(withExtension('/tmp/plan.tasklace', 'csv')).toBe('/tmp/plan.tasklace.csv');
    expect(withExtension('/tmp/plan.v2', 'tasklace')).toBe('/tmp/plan.v2.tasklace');
  });
});
