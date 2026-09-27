import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compileCalendar } from '../calendar/compile-calendar';
import { MAX_PROJECT_TEXT_UTF16_UNITS, MAX_TAG_NAME_LENGTH } from '../limits';
import type { Project, Task, WorkTask } from '../model/project';
import { PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../testing/arbitraries';
import { at, dayOf } from '../testing/civil-time';
import { projectArbitrary } from '../testing/project-arbitrary';
import { link, milestone, project, splitTask, summary, workTask } from '../testing/project-builder';
import { END_PROJECT_HOUR, MIN_PROJECT_HOUR } from '../time';
import { createIssueList, type ValidationIssue } from '../validation/validation-issues';
import { readText } from '../validation/value-readers';
import {
  exportProjectJson,
  importProjectJson,
  PROJECT_JSON_FORMAT,
  PROJECT_JSON_VERSION,
} from './project-json';

type Data = Record<string, unknown>;

const DEEP_NESTING = 100_000;

const SAMPLE_PROJECT: Project = project(
  [
    summary('phase', { name: 'Phase 1 — 設計' }),
    workTask('a', {
      name: 'Rédiger « la note » 📝',
      parentId: 'phase',
      tagId: 'design',
      progressPercent: 30,
      hoursPerDay: 3,
      dailyStartHour: 14,
      startNoEarlierThan: at(2026, 10, 1, 9),
      mustFinishOn: at(2026, 10, 20, 17),
      deadline: null,
    }),
    splitTask(
      'b',
      [
        [4, 0],
        [2, 3],
      ],
      { deadline: at(2026, 11, 2, 12) },
    ),
    milestone('m', { progressPercent: 100 }),
  ],
  [link('a', 'b', 'finishToStart', 2), link('b', 'm', 'startToFinish', -1)],
  {
    name: 'Sample',
    tags: [{ id: 'design', name: 'Design', color: '#336699', representsPersonOrTeam: true }],
    calendar: {
      workingWeekdays: [0, 1, 6],
      workingTimeRanges: [{ startHour: 0, endHour: 24 }],
      nonWorkingPeriods: [{ firstDay: dayOf(2026, 12, 24), lastDay: dayOf(2027, 1, 1) }],
    },
  },
);

/** Returns the sample project exported as JSON and parsed back into plain data. */
function sampleDocument(): Data {
  return JSON.parse(exportProjectJson(SAMPLE_PROJECT)) as Data;
}

/** Returns the issues found when importing a document, or an empty list when it is valid. */
function importIssues(document: unknown): readonly ValidationIssue[] {
  const text = typeof document === 'string' ? document : JSON.stringify(document);
  const result = importProjectJson(text);
  return result.ok ? [] : result.error;
}

/** Returns the sample document with one field of its project replaced. */
function projectFieldWith(key: string, value: unknown): Data {
  const document = sampleDocument();
  return { ...document, project: { ...(document['project'] as Data), [key]: value } };
}

/** Returns the sample document with one field of one of its tasks replaced. */
function taskFieldWith(index: number, key: string, value: unknown): Data {
  const document = sampleDocument();
  const content = document['project'] as Data;
  const tasks = [...(content['tasks'] as Data[])];
  tasks[index] = { ...tasks[index], [key]: value };
  return { ...document, project: { ...content, tasks } };
}

/** Returns the sample document with one field of its calendar replaced. */
function calendarFieldWith(key: string, value: unknown): Data {
  const content = sampleDocument()['project'] as Data;
  return projectFieldWith('calendar', { ...(content['calendar'] as Data), [key]: value });
}

/** Builds the single issue expected at a location. */
function issue(path: string, code: ValidationIssue['code']): ValidationIssue[] {
  return [{ path, code }];
}

describe('exportProjectJson', () => {
  it('writes a versioned document indented with two spaces', () => {
    const text = exportProjectJson(SAMPLE_PROJECT);
    expect(text.startsWith('{\n  "format": "tasklace",\n  "version": 1,\n  "project": {')).toBe(
      true,
    );
    const document = JSON.parse(text) as Data;
    expect(document['format']).toBe(PROJECT_JSON_FORMAT);
    expect(document['version']).toBe(PROJECT_JSON_VERSION);
  });

  it('writes dates, days and weekdays in clear text', () => {
    const content = sampleDocument()['project'] as Data;
    expect(content['startDate']).toBe('2026-09-28T09:00');
    expect(content['calendar']).toEqual({
      workingWeekdays: ['sunday', 'monday', 'saturday'],
      workingTimeRanges: [{ startHour: 0, endHour: 24 }],
      nonWorkingPeriods: [{ firstDay: '2026-12-24', lastDay: '2027-01-01' }],
    });
    const [phase, first, second] = content['tasks'] as Data[];
    expect(phase).toEqual({
      kind: 'summary',
      id: 'phase',
      name: 'Phase 1 — 設計',
      parentId: null,
      sortKey: 'phase',
    });
    expect(first).toMatchObject({
      startNoEarlierThan: '2026-10-01T09:00',
      mustFinishOn: '2026-10-20T17:00',
      deadline: null,
    });
    expect(second).toMatchObject({ startNoEarlierThan: null, deadline: '2026-11-02T12:00' });
  });

  it('writes the extreme dates of the supported period', () => {
    const extreme = project([], [], { startDate: at(2020, 1, 1, 0) });
    expect((JSON.parse(exportProjectJson(extreme)) as { project: Data }).project['startDate']).toBe(
      '2020-01-01T00:00',
    );
    const late = project([], [], { startDate: at(2200, 12, 31, 23) });
    expect(importProjectJson(exportProjectJson(late))).toEqual({ ok: true, value: late });
  });
});

describe('importProjectJson: round trip', () => {
  it('reads back the exported sample project unchanged', () => {
    expect(importProjectJson(exportProjectJson(SAMPLE_PROJECT))).toEqual({
      ok: true,
      value: SAMPLE_PROJECT,
    });
  });

  it(
    'reads back every generated project unchanged and writes it again with the same content',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(projectArbitrary, ({ project: input }) => {
          const text = exportProjectJson(input);
          const imported = importProjectJson(text);
          expect(imported).toEqual({ ok: true, value: input });
          const written = imported.ok ? exportProjectJson(imported.value) : '';
          expect(JSON.parse(written)).toEqual(JSON.parse(text));
        }),
      );
    },
  );

  it('accepts a compact document with keys in any order', () => {
    const { project: content, version, format } = sampleDocument();
    const text = JSON.stringify({ project: content, version, format });
    expect(importProjectJson(text)).toEqual({ ok: true, value: SAMPLE_PROJECT });
  });
});

describe('project JSON: baseline', () => {
  it('writes the baseline dates in clear text and reads them back', () => {
    const baseline = {
      takenAt: at(2026, 9, 27, 18),
      entries: [
        { taskId: 'a', start: at(2026, 10, 1, 9), end: at(2026, 10, 2, 17), durationHours: 14 },
      ],
    };
    const input = { ...SAMPLE_PROJECT, baseline };
    const text = exportProjectJson(input);
    expect((JSON.parse(text) as { project: Data }).project['baseline']).toEqual({
      takenAt: '2026-09-27T18:00',
      entries: [
        { taskId: 'a', start: '2026-10-01T09:00', end: '2026-10-02T17:00', durationHours: 14 },
      ],
    });
    expect(importProjectJson(text)).toEqual({ ok: true, value: input });
  });

  it('rejects a baseline date written as a number', () => {
    expect(importIssues(projectFieldWith('baseline', { takenAt: 0, entries: [] }))).toEqual(
      issue('project.baseline.takenAt', 'WRONG_TYPE'),
    );
  });
});

describe('importProjectJson: byte order mark', () => {
  const text = exportProjectJson(SAMPLE_PROJECT);

  it('accepts a single byte order mark at the start of the text', () => {
    expect(importProjectJson(`\uFEFF${text}`)).toEqual({ ok: true, value: SAMPLE_PROJECT });
  });

  it('rejects two byte order marks at the start of the text', () => {
    expect(importIssues(`\uFEFF\uFEFF${text}`)).toEqual(issue('', 'INVALID_JSON'));
  });

  it('rejects a byte order mark between two tokens', () => {
    expect(importIssues(text.replace('"version"', '\uFEFF"version"'))).toEqual(
      issue('', 'INVALID_JSON'),
    );
  });

  it('keeps a byte order mark inside a text value intact', () => {
    const named = project([workTask('a', { name: 'a\uFEFFb' })]);
    expect(importProjectJson(`\uFEFF${exportProjectJson(named)}`)).toEqual({
      ok: true,
      value: named,
    });
  });

  it('never writes a byte order mark', () => {
    expect(text.startsWith('{')).toBe(true);
    expect(text.includes('\uFEFF')).toBe(false);
  });
});

describe('importProjectJson: text and header', () => {
  it.each(['', ' ', '{', '{"format":', 'NaN', "{'format': 'tasklace'}", '{"a":1,}', '\u0000'])(
    'rejects the invalid JSON %j',
    (text) => {
      expect(importIssues(text)).toEqual(issue('', 'INVALID_JSON'));
    },
  );

  it('rejects a text longer than the maximum size before parsing it', () => {
    expect(importIssues(' '.repeat(MAX_PROJECT_TEXT_UTF16_UNITS + 1))).toEqual(
      issue('', 'TOO_LARGE'),
    );
  });

  it.each(['[]', 'null', '42', '"tasklace"', 'true'])('rejects the document %s', (text) => {
    expect(importIssues(text)).toEqual(issue('', 'WRONG_TYPE'));
  });

  it('rejects a deeply nested document without crashing', () => {
    const nested = `{"format":"tasklace","version":1,"project":${'['.repeat(DEEP_NESTING)}${']'.repeat(DEEP_NESTING)}}`;
    expect(importIssues(nested)).toEqual(issue('project', 'WRONG_TYPE'));
  });

  it('reports unknown top-level fields and a missing header', () => {
    expect(importIssues({ ...sampleDocument(), comment: 'hi' })).toEqual(
      issue('comment', 'UNKNOWN_FIELD'),
    );
    expect(importIssues({ project: {} })).toEqual([
      { path: 'format', code: 'MISSING_FIELD' },
      { path: 'version', code: 'MISSING_FIELD' },
    ]);
  });

  it.each([
    ['gantt', 'UNSUPPORTED_FORMAT'],
    ['Tasklace', 'UNSUPPORTED_FORMAT'],
    [1, 'WRONG_TYPE'],
  ] as const)('rejects the format %j', (format, code) => {
    expect(importIssues({ ...sampleDocument(), format })).toEqual(issue('format', code));
  });

  it.each([
    [2, 'UNSUPPORTED_VERSION'],
    [0, 'UNSUPPORTED_VERSION'],
    [Number.MAX_SAFE_INTEGER, 'UNSUPPORTED_VERSION'],
    [-1, 'OUT_OF_RANGE'],
    ['1', 'WRONG_TYPE'],
    [1.5, 'WRONG_TYPE'],
  ] as const)('rejects the version %j', (version, code) => {
    expect(importIssues({ ...sampleDocument(), version })).toEqual(issue('version', code));
  });

  it('rejects a version too large to be a JSON number', () => {
    const text = exportProjectJson(SAMPLE_PROJECT).replace('"version": 1', '"version": 1e400');
    expect(importIssues(text)).toEqual(issue('version', 'WRONG_TYPE'));
  });

  it('checks the header before reading the project', () => {
    expect(importIssues({ format: 'tasklace', version: 2, project: null })).toEqual(
      issue('version', 'UNSUPPORTED_VERSION'),
    );
  });

  it('reports a missing project', () => {
    expect(importIssues({ format: 'tasklace', version: 1 })).toEqual(
      issue('project', 'MISSING_FIELD'),
    );
  });

  it('reports an own __proto__ key without polluting objects', () => {
    const text = exportProjectJson(SAMPLE_PROJECT).replace(
      '"project": {',
      '"project": {"__proto__": {"polluted": true}, ',
    );
    expect(importIssues(`{"__proto__": {"polluted": true}, ${text.slice(1)}`)).toEqual(
      issue('__proto__', 'UNKNOWN_FIELD'),
    );
    expect(({} as Data)['polluted']).toBeUndefined();
  });

  it('never throws on arbitrary text', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(importProjectJson(text).ok).toBe(false);
      }),
    );
  });

  it('never throws on arbitrary JSON', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(importProjectJson(JSON.stringify(value)).ok).toBe(false);
      }),
    );
  });

  it(
    'rejects every truncated export as invalid JSON',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const text = exportProjectJson(SAMPLE_PROJECT);
      fc.assert(
        fc.property(fc.integer({ min: 0, max: text.length - 1 }), (length) => {
          expect(importIssues(text.slice(0, length))).toEqual(issue('', 'INVALID_JSON'));
        }),
      );
    },
  );
});

describe('importProjectJson: values', () => {
  it.each(['2020-01-01T00:00', '2200-12-31T23:00', '2028-02-29T12:00'])(
    'accepts the date and time %s',
    (startDate) => {
      expect(importIssues(projectFieldWith('startDate', startDate))).toEqual([]);
    },
  );

  it.each([
    '',
    '2026-02-29T09:00',
    '2026-02-30T09:00',
    '2026-13-01T09:00',
    '2026-00-10T09:00',
    '2026-09-00T09:00',
    '2026-09-28T24:00',
    '2026-09-28T09:30',
    '2026-09-28T09:00:00',
    '2026-09-28T09:00Z',
    '2026-09-28 09:00',
    '2026-9-28T09:00',
    '2026-09-28',
    '2019-12-31T23:00',
    '2201-01-01T00:00',
    '+02026-09-28T09:00',
    '２０２６-09-28T09:00',
  ])('rejects the date and time %j', (startDate) => {
    expect(importIssues(projectFieldWith('startDate', startDate))).toEqual(
      issue('project.startDate', 'INVALID_DATE'),
    );
  });

  it('rejects a date written as a number', () => {
    expect(importIssues(projectFieldWith('startDate', at(2026, 9, 28, 9)))).toEqual(
      issue('project.startDate', 'WRONG_TYPE'),
    );
  });

  it.each(['2026-02-29', '2026-12-24T00:00', '26-12-24', '2026-12-32'])(
    'rejects the day %j',
    (firstDay) => {
      const periods = [{ firstDay, lastDay: '2027-01-01' }];
      expect(importIssues(calendarFieldWith('nonWorkingPeriods', periods))).toEqual(
        issue('project.calendar.nonWorkingPeriods[0].firstDay', 'INVALID_DATE'),
      );
    },
  );

  it('reports a period ending before it starts', () => {
    const periods = [{ firstDay: '2027-01-02', lastDay: '2027-01-01' }];
    expect(importIssues(calendarFieldWith('nonWorkingPeriods', periods))).toEqual(
      issue('project.calendar.nonWorkingPeriods[0]', 'INVALID_NON_WORKING_PERIOD'),
    );
  });

  it.each([
    [['Monday'], 'OUT_OF_RANGE'],
    [['lundi'], 'OUT_OF_RANGE'],
    [[1], 'WRONG_TYPE'],
  ] as const)('rejects the weekdays %j', (weekdays, code) => {
    expect(importIssues(calendarFieldWith('workingWeekdays', weekdays))).toEqual(
      issue('project.calendar.workingWeekdays[0]', code),
    );
  });

  it('reports a weekday given twice', () => {
    expect(importIssues(calendarFieldWith('workingWeekdays', ['monday', 'monday']))).toEqual(
      issue('project.calendar.workingWeekdays[1]', 'DUPLICATE_WEEKDAY'),
    );
  });

  it('rejects an invalid constraint date on a task', () => {
    expect(importIssues(taskFieldWith(1, 'deadline', 'tomorrow'))).toEqual(
      issue('project.tasks[1].deadline', 'INVALID_DATE'),
    );
  });

  it.each(['a\u0000b', '\ud800', 'line\nbreak'])('rejects the task name %j', (name) => {
    expect(importIssues(taskFieldWith(1, 'name', name))).toEqual(
      issue('project.tasks[1].name', 'INVALID_TEXT'),
    );
  });

  it('reports a daily pattern that does not fit the calendar', () => {
    const narrow = [{ startHour: 14, endHour: 16 }];
    const document = calendarFieldWith('workingTimeRanges', narrow);
    expect(importIssues(document)).toEqual(
      issue('project.tasks[1].hoursPerDay', 'INVALID_HOURS_PER_DAY'),
    );
  });

  it('reports structure problems with their location in the document', () => {
    expect(importIssues(taskFieldWith(2, 'id', 'a'))).toContainEqual({
      path: 'project.tasks[2]',
      code: 'DUPLICATE_TASK_ID',
    });
  });
});

const MAX_GENERATED_TAGS = 12;

const tagArbitrary = fc.record({
  id: fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
  name: fc
    .string({ unit: 'grapheme', minLength: 1, maxLength: MAX_TAG_NAME_LENGTH })
    .filter(
      (name) =>
        readText({ value: name, path: '' }, createIssueList(), MAX_TAG_NAME_LENGTH) !== undefined,
    ),
  color: fc
    .integer({ min: 0, max: 0xffffff })
    .map((value) => `#${value.toString(16).padStart(6, '0')}`),
  representsPersonOrTeam: fc.boolean(),
});

const fullRangeInstant = fc.integer({ min: MIN_PROJECT_HOUR, max: END_PROJECT_HOUR - 1 });

/** Picks a daily start hour that leaves a work task enough working hours in the day. */
function dailyStartArbitrary(task: WorkTask, hoursOfDay: readonly number[]) {
  const hoursPerDay = task.hoursPerDay ?? hoursOfDay.length;
  return fc.option(fc.constantFrom(...hoursOfDay.slice(0, hoursOfDay.length - hoursPerDay + 1)));
}

/** Adds random tags, date constraints, daily start hours and options to a generated project. */
function enrichProject(input: Project): fc.Arbitrary<Project> {
  const hoursOfDay = unwrap(compileCalendar(input.calendar)).workingHoursOfDay;
  const tags = fc.uniqueArray(tagArbitrary, {
    maxLength: MAX_GENERATED_TAGS,
    selector: (tag) => tag.id,
  });
  return tags.chain((generatedTags) => {
    const tagIds = [...generatedTags.map((tag) => tag.id), 'unknown-tag'];
    const tasks = fc.tuple(
      ...input.tasks.map((task): fc.Arbitrary<Task> => {
        if (task.kind === 'summary') {
          return fc.constant(task);
        }
        const dated = fc.record({
          tagId: fc.option(fc.constantFrom(...tagIds)),
          mustFinishOn: fc.option(fullRangeInstant),
          deadline: fc.option(fullRangeInstant),
        });
        if (task.kind === 'milestone') {
          return dated.map((fields) => ({ ...task, ...fields }));
        }
        return fc
          .tuple(dated, dailyStartArbitrary(task, hoursOfDay))
          .map(([fields, dailyStartHour]) => ({ ...task, ...fields, dailyStartHour }));
      }),
    );
    const options = fc.record({
      criticalPathEnabled: fc.boolean(),
      dateConstraintsEnabled: fc.boolean(),
      alwaysShowPatterns: fc.boolean(),
    });
    return fc.tuple(tasks, options).map(([enrichedTasks, enrichedOptions]) => ({
      ...input,
      tags: generatedTags,
      tasks: enrichedTasks,
      options: enrichedOptions,
    }));
  });
}

/** Lists the path of every leaf value inside plain JSON data. */
function leafPaths(value: unknown, path: readonly (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leafPaths(item, [...path, index]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => leafPaths(item, [...path, key]));
  }
  return [[...path]];
}

/** Returns a copy of plain JSON data with the value at a path replaced. */
function withValueAt(data: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) {
    return value;
  }
  if (Array.isArray(data)) {
    return (data as unknown[]).map((item, index) =>
      index === head ? withValueAt(item, rest, value) : item,
    );
  }
  const record = data as Data;
  return { ...record, [head]: withValueAt(record[String(head)], rest, value) };
}

describe(
  'importProjectJson: generated and mutated documents',
  { timeout: PROPERTY_TEST_TIMEOUT_MS },
  () => {
    it('reads back every enriched project unchanged', () => {
      fc.assert(
        fc.property(
          projectArbitrary.chain(({ project: input }) => enrichProject(input)),
          (input) => {
            expect(importProjectJson(exportProjectJson(input))).toEqual({ ok: true, value: input });
          },
        ),
      );
    });

    it('never throws when any nested value is replaced, and locates every issue in the project', () => {
      const document = sampleDocument();
      const paths = leafPaths(document['project'], ['project']);
      fc.assert(
        fc.property(fc.constantFrom(...paths), fc.jsonValue(), (path, value) => {
          const result = importProjectJson(JSON.stringify(withValueAt(document, path, value)));
          const outside = result.ok
            ? []
            : result.error.filter((found) => !found.path.startsWith('project'));
          expect(outside).toEqual([]);
        }),
      );
    });
  },
);
