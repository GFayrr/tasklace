import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_CALENDAR } from '../../calendar/default-calendar';
import {
  MAX_CSV_COLUMNS,
  MAX_CSV_TEXT_UTF16_UNITS,
  MAX_DEPENDENCIES,
  MAX_TAGS,
  MAX_TASKS,
} from '../../limits';
import type { Project, Task } from '../../model/project';
import { scheduleProject, type Schedule } from '../../scheduling/schedule-project';
import { TAG_PALETTE } from '../../tags/tag-palette';
import { PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../../testing/arbitraries';
import { at } from '../../testing/civil-time';
import { projectArbitrary } from '../../testing/project-arbitrary';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  workTask,
} from '../../testing/project-builder';
import type { ValidationIssue } from '../../validation/validation-issues';
import { keepAllColumns, parseCsv } from './csv-text';
import { CSV_BYTE_ORDER_MARK, exportProjectCsv } from './project-csv-export';
import { importProjectCsv, type CsvImport } from './project-csv-import';
import type { RegionalFormat } from './regional-format';

const FRENCH: RegionalFormat = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
};
const AMERICAN: RegionalFormat = {
  listSeparator: ',',
  dateOrder: 'monthDayYear',
  dateSeparator: '/',
  twelveHourClock: true,
};
const FALLBACK_START = at(2026, 9, 28, 9);
const HEADER = 'WBS;Name;Start;End;Duration (h);Progress (%);Predecessors;Tag;Blocks';
const DESIGN = { id: 'design', name: 'Design', color: '#336699', representsPersonOrTeam: true };

const SAMPLE = project(
  [
    summary('phase', { name: '=Phase' }),
    workTask('write', { parentId: 'phase', name: 'Écrire; "le plan"', tagId: 'design' }),
    splitTask(
      'split',
      [
        [4, 0],
        [3, 2],
      ],
      { parentId: 'phase', progressPercent: 40 },
    ),
    milestone('done', { progressPercent: 100 }),
    workTask('late', { startNoEarlierThan: at(2026, 10, 5, 13) }),
  ],
  [link('write', 'split', 'startToStart', 2), link('split', 'done')],
  { tags: [DESIGN] },
);

/** Imports CSV text with the French format and the fallback start. */
function importFrench(text: string): ReturnType<typeof importProjectCsv> {
  return importProjectCsv(text, {
    format: FRENCH,
    projectName: 'Imported',
    fallbackStart: FALLBACK_START,
  });
}

/** Imports CSV text written as lines under the French header, failing the test when it is refused. */
function importLines(...lines: string[]): CsvImport {
  const imported = importFrench([HEADER, ...lines].join('\n'));
  if (!imported.ok) {
    throw new Error(JSON.stringify(imported.error));
  }
  return imported.value;
}

/** Returns the issues found when importing lines under the French header. */
function issuesOf(...lines: string[]): readonly ValidationIssue[] {
  const imported = importFrench([HEADER, ...lines].join('\n'));
  return imported.ok ? [] : imported.error;
}

/** Keeps only what a task table can hold: default calendar and options, no daily pattern and no advanced date constraint. */
function tableCompatible(input: Project): Project {
  const tasks = input.tasks.map((task): Task =>
    task.kind === 'summary'
      ? task
      : {
          ...task,
          mustFinishOn: null,
          deadline: null,
          ...(task.kind === 'task' ? { hoursPerDay: null, dailyStartHour: null } : {}),
        },
  );
  return {
    ...input,
    tasks,
    calendar: DEFAULT_CALENDAR,
    options: {
      criticalPathEnabled: false,
      dateConstraintsEnabled: false,
      alwaysShowPatterns: false,
    },
  };
}

const NAME_CHARACTERS = ['a', 'Z', 'é', '字', '😀', ' ', ';', ',', '"', '=', '+', '-', '@', "'"];
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];
const TABLE_LIMITS = { maxColumns: MAX_CSV_COLUMNS, maxRows: MAX_TASKS };
const MAX_GENERATED_NAME_LENGTH = 40;
const MAX_GENERATED_TAGS = 4;
const MAX_GENERATED_TASKS = 24;

const nameArbitrary = fc
  .string({
    unit: fc.constantFrom(...NAME_CHARACTERS),
    minLength: 1,
    maxLength: MAX_GENERATED_NAME_LENGTH,
  })
  .filter((name) => name.trim() !== '');

/** Generates table-compatible projects whose tasks carry random names, including separators, quotes and formula characters, and random tags. */
const namedProjectArbitrary = fc
  .record({
    generated: projectArbitrary,
    names: fc.array(nameArbitrary, {
      minLength: MAX_GENERATED_TASKS,
      maxLength: MAX_GENERATED_TASKS,
    }),
    tagNames: fc.uniqueArray(
      nameArbitrary.map((name) => name.trim()),
      {
        maxLength: MAX_GENERATED_TAGS,
      },
    ),
    tagChoices: fc.array(fc.nat(), {
      minLength: MAX_GENERATED_TASKS,
      maxLength: MAX_GENERATED_TASKS,
    }),
  })
  .map(({ generated, names, tagNames, tagChoices }) => {
    const input = tableCompatible(generated.project);
    const tags = tagNames
      .filter((name) => name !== '')
      .map((name, index) => ({
        id: `tag${String(index)}`,
        name,
        color: '#336699',
        representsPersonOrTeam: false,
      }));
    const tasks = input.tasks.map((task, index): Task => {
      const name = names[index] ?? task.name;
      if (task.kind === 'summary') {
        return { ...task, name };
      }
      const choice = (tagChoices[index] ?? 0) % (tags.length + 1);
      return { ...task, name, tagId: tags[choice]?.id ?? null };
    });
    return { ...input, tasks, tags };
  });

/** Describes a scheduled project by WBS number, independently of its identifiers. */
function describeByWbs(input: Project, schedule: Schedule) {
  const wbs = (id: string | null) => (id === null ? null : (schedule.wbsNumbers.get(id) ?? '?'));
  const tagName = (id: string | null) => input.tags.find((tag) => tag.id === id)?.name ?? null;
  const tasks = input.tasks.map((task) => ({
    wbs: wbs(task.id),
    name: task.name,
    kind: task.kind,
    parent: wbs(task.parentId),
    progress: task.kind === 'summary' ? null : task.progressPercent,
    tag: task.kind === 'summary' ? null : tagName(task.tagId),
    segments: task.kind === 'task' ? task.segments : null,
    dates:
      task.kind === 'summary' ? schedule.summaries.get(task.id) : schedule.placements.get(task.id),
  }));
  const dependencies = input.dependencies.map((dependency) => ({
    from: wbs(dependency.predecessorId),
    to: wbs(dependency.successorId),
    type: dependency.type,
    lagHours: dependency.lagHours,
  }));
  const byText = (left: object, right: object) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right));
  return { tasks: tasks.sort(byText), dependencies: dependencies.sort(byText) };
}

describe('exportProjectCsv', () => {
  const text = unwrap(exportProjectCsv(SAMPLE, scheduleOrThrow(SAMPLE), FRENCH));

  it('writes a byte order mark, the header and one row per task in WBS order, with Windows line ends', () => {
    expect(text).toBe(
      [
        `${CSV_BYTE_ORDER_MARK}${HEADER}`,
        '1;done;30/09/2026 12:00;30/09/2026 12:00;0;100;3.1;;',
        '2;late;05/10/2026 13:00;06/10/2026 12:00;7;0;;;',
        "3;'=Phase;28/09/2026 09:00;30/09/2026 12:00;;20;;;",
        '3.1;split;28/09/2026 11:00;30/09/2026 12:00;7;40;3.2SS+2h;;"4h; +2d 3h"',
        '3.2;"Écrire; ""le plan""";28/09/2026 09:00;28/09/2026 17:00;7;0;;Design;',
        '',
      ].join('\r\n'),
    );
  });

  it('refuses a schedule computed for another version of the project', () => {
    const older = project([workTask('a')]);
    const newer = project([workTask('a'), workTask('b')]);
    expect(exportProjectCsv(newer, scheduleOrThrow(older), FRENCH)).toEqual({
      ok: false,
      error: 'SCHEDULE_MISMATCH',
    });
  });

  it('leaves the tag cell empty for a tag the project does not define', () => {
    const lost = project([workTask('a', { tagId: 'missing' })]);
    expect(unwrap(exportProjectCsv(lost, scheduleOrThrow(lost), FRENCH))).toContain(
      '1;a;28/09/2026 09:00;28/09/2026 17:00;7;0;;;\r\n',
    );
  });

  it('writes dates in the regional order and clock, quoting only the cells holding its separator', () => {
    const american = unwrap(exportProjectCsv(SAMPLE, scheduleOrThrow(SAMPLE), AMERICAN));
    expect(american).toContain(
      '3.1,split,09/28/2026 11:00 AM,09/30/2026 12:00 PM,7,40,3.2SS+2h,,4h; +2d 3h',
    );
    expect(american).toContain('3.2,"Écrire; ""le plan""",09/28/2026 9:00 AM,09/28/2026 5:00 PM');
  });
});

describe('importProjectCsv round trip', () => {
  it('rebuilds the sample project and places every task at the same hours', () => {
    const text = unwrap(exportProjectCsv(SAMPLE, scheduleOrThrow(SAMPLE), FRENCH));
    const imported = importFrench(text);
    if (!imported.ok) {
      throw new Error(JSON.stringify(imported.error));
    }
    const { project: rebuilt, warnings } = imported.value;
    expect(warnings).toEqual([]);
    expect(describeByWbs(rebuilt, scheduleOrThrow(rebuilt))).toEqual(
      describeByWbs(SAMPLE, scheduleOrThrow(SAMPLE)),
    );
    expect(rebuilt.name).toBe('Imported');
    expect(rebuilt.tags).toEqual([
      { id: 'tag-1', name: 'Design', color: TAG_PALETTE[0], representsPersonOrTeam: false },
    ]);
  });

  it('keeps a start date only where the schedule needs it', () => {
    const { project: rebuilt } = importLines(
      '1;first;28/09/2026 09:00;;7',
      '2;second;29/09/2026 09:00;;7;;1',
      '3;later;05/10/2026 09:00;;7',
    );
    expect(rebuilt.startDate).toBe(at(2026, 9, 28, 9));
    expect(
      rebuilt.tasks.map((task) => (task.kind === 'summary' ? null : task.startNoEarlierThan)),
    ).toEqual([null, null, at(2026, 10, 5, 9)]);
  });

  it(
    'rebuilds every table-compatible project, with any names and tags, with identical dates and no warning',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(namedProjectArbitrary, fc.constantFrom(FRENCH, AMERICAN), (input, format) => {
          const schedule = scheduleProject(input);
          fc.pre(schedule.ok);
          const text = unwrap(exportProjectCsv(input, schedule.value, format));
          const imported = importProjectCsv(text, {
            format,
            projectName: 'Imported',
            fallbackStart: FALLBACK_START,
          });
          if (!imported.ok) {
            throw new Error(JSON.stringify(imported.error));
          }
          expect(imported.value.warnings).toEqual([]);
          expect(describeByWbs(imported.value.project, imported.value.schedule)).toEqual(
            describeByWbs(input, schedule.value),
          );
        }),
      );
    },
  );

  it(
    'never writes a cell a spreadsheet could run as a formula',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(namedProjectArbitrary, (input) => {
          const schedule = scheduleProject(input);
          fc.pre(schedule.ok);
          const text = unwrap(exportProjectCsv(input, schedule.value, FRENCH));
          const table = unwrap(
            parseCsv(text.slice(CSV_BYTE_ORDER_MARK.length), ';', TABLE_LIMITS, keepAllColumns),
          );
          const cells = [table.header, ...table.rows.map((row) => row.cells)].flat();
          expect(cells.filter((cell) => FORMULA_TRIGGERS.includes(cell.charAt(0)))).toEqual([]);
        }),
      );
    },
  );
});

describe('importProjectCsv reading a table written by hand', () => {
  it('builds the hierarchy from WBS numbers and a flat list without them', () => {
    const nested = importLines('1;Phase', '1.1;Task;;;7', '2;Heading');
    expect(nested.project.tasks.map((task) => [task.kind, task.parentId])).toEqual([
      ['summary', null],
      ['task', 'task-1'],
      ['summary', null],
    ]);
    const flat = importFrench('Name,Duration\nA,7\nB,0\nC,3\n');
    expect(flat.ok && flat.value.project.tasks.map((task) => [task.kind, task.parentId])).toEqual([
      ['task', null],
      ['milestone', null],
      ['task', null],
    ]);
  });

  it('numbers rows by position when the WBS column is present but empty', () => {
    const { project: rebuilt } = importLines(';A;;;7;;;;', ';B;;;7;;1;;');
    expect(rebuilt.dependencies).toEqual([
      {
        id: 'dependency-1',
        predecessorId: 'task-1',
        successorId: 'task-2',
        type: 'finishToStart',
        lagHours: 0,
      },
    ]);
  });

  it('starts at the fallback date when no row has a start, and reads ISO dates and percentages', () => {
    expect(importLines('1;A;;;7').project.startDate).toBe(FALLBACK_START);
    const { project: rebuilt } = importLines('1;A;2026-10-01 10:00;;7;50 %');
    expect(rebuilt.startDate).toBe(at(2026, 10, 1, 10));
    expect(rebuilt.tasks[0]).toMatchObject({ progressPercent: 50 });
  });

  it('accepts columns in any order and any case, warning about unknown columns and extra cells', () => {
    const imported = importFrench('duration (hours);NAME;Owner\n7;A;Kim;extra\n');
    expect(imported.ok && imported.value.warnings).toEqual([
      { path: 'columns[3]', code: 'UNKNOWN_COLUMN' },
      { path: 'rows[2]', code: 'EXTRA_CELLS' },
    ]);
  });

  it('creates each tag once with the next palette color', () => {
    const { project: rebuilt } = importLines('1;A;;;7;;;Dev', '2;B;;;7;;;Test', '3;C;;;7;;;Dev');
    expect(rebuilt.tags.map((tag) => [tag.name, tag.color])).toEqual([
      ['Dev', TAG_PALETTE[0]],
      ['Test', TAG_PALETTE[1]],
    ]);
    expect(rebuilt.tasks.map((task) => (task.kind === 'summary' ? null : task.tagId))).toEqual([
      'tag-1',
      'tag-2',
      'tag-1',
    ]);
  });

  it('gives back a name the export escaped, and keeps a leading apostrophe of the user', () => {
    const { project: rebuilt } = importLines("1;'=SUM(A1);;;7", "2;'quoted;;;7");
    expect(rebuilt.tasks.map((task) => task.name)).toEqual(['=SUM(A1)', "'quoted"]);
  });

  it('removes a single leading byte order mark and keeps any other one', () => {
    const imported = importFrench(`${CSV_BYTE_ORDER_MARK}Name;Duration\n${CSV_BYTE_ORDER_MARK}A;7`);
    expect(imported.ok && imported.value.project.tasks[0]?.name).toBe(`${CSV_BYTE_ORDER_MARK}A`);
  });

  it('warns about values a summary does not use and about dates the schedule does not follow', () => {
    const imported = importLines(
      '1;Phase;;;9;;;Dev;',
      '1.1;A;28/09/2026 09:00;28/09/2026 12:00;7',
      '1.2;B;28/09/2026;30/09/2026;7;;1.1',
    );
    expect(imported.warnings).toEqual([
      { path: 'rows[2].duration', code: 'IGNORED_VALUE' },
      { path: 'rows[2].tag', code: 'IGNORED_VALUE' },
      { path: 'rows[3].end', code: 'END_DIFFERS' },
      { path: 'rows[4].start', code: 'START_DIFFERS' },
      { path: 'rows[4].end', code: 'END_DIFFERS' },
    ]);
  });
});

describe('importProjectCsv choices made for the user', () => {
  it('orders siblings by their WBS numbers rather than by row', () => {
    const imported = importLines('2;B;;;7', '1;A;;;7');
    expect(imported.schedule.wbsNumbers.get('task-2')).toBe('1');
    expect(imported.schedule.wbsNumbers.get('task-1')).toBe('2');
  });

  it.each([
    ['only an end', '1;A;;28/09/2026'],
    ['only a progress', '1;A;;;;50'],
    ['only a tag', '1;A;;;;;;Dev'],
  ])(
    'refuses a row without duration holding %s, instead of making it a heading',
    (_label, line) => {
      expect(issuesOf(line)).toEqual([{ path: 'rows[2].duration', code: 'MISSING_FIELD' }]);
    },
  );

  it('refuses a row without duration holding only a predecessor', () => {
    expect(issuesOf('1;X;;;7', '2;A;;;;;1')).toEqual([
      { path: 'rows[3].duration', code: 'MISSING_FIELD' },
    ]);
  });

  it('keeps no start date for a task its predecessor already pushes past it', () => {
    const imported = importLines(
      '1;C;01/10/2026 09:00;;7',
      '2;A;05/10/2026 09:00;;7',
      '3;B;03/10/2026 09:00;;7;;2',
    );
    expect(
      imported.project.tasks.map((task) =>
        task.kind === 'summary' ? null : task.startNoEarlierThan,
      ),
    ).toEqual([null, at(2026, 10, 5, 9), null]);
    expect(imported.warnings).toEqual([{ path: 'rows[4].start', code: 'START_DIFFERS' }]);
  });

  it('keeps a date without hour as a start at the first working hour of that day', () => {
    const imported = importLines('1;A;28/09/2026;;7', '2;B;05/10/2026;05/10/2026;7');
    expect(imported.warnings).toEqual([]);
    expect(imported.project.tasks[1]).toMatchObject({ startNoEarlierThan: at(2026, 10, 5, 0) });
    expect(imported.schedule.placements.get('task-2')?.start).toBe(at(2026, 10, 5, 9));
  });

  it('warns about the start of a summary that has no dated task below it', () => {
    expect(importLines('1;Phase;28/09/2026', '1.1;Sub').warnings).toEqual([
      { path: 'rows[2].start', code: 'START_DIFFERS' },
    ]);
  });

  it('warns about a summary progress that its children do not give, and about blocks on a summary', () => {
    expect(importLines('1;Phase;;;;80;;;"1h; +1d 1h"', '1.1;A;;;7;0').warnings).toEqual([
      { path: 'rows[2].blocks', code: 'IGNORED_VALUE' },
      { path: 'rows[2].progress', code: 'PROGRESS_DIFFERS' },
    ]);
  });

  it('warns about values in a column without header', () => {
    const imported = importFrench('Name;;Duration\nA;important note;4\n');
    expect(imported.ok && imported.value.warnings).toEqual([
      { path: 'columns[2]', code: 'UNKNOWN_COLUMN' },
    ]);
  });

  it('trims tag names and keeps tags differing only by case apart', () => {
    const { project: rebuilt } = importLines('1;A;;;7;;; Dev ', '2;B;;;7;;;dev');
    expect(rebuilt.tags.map((tag) => tag.name)).toEqual(['Dev', 'dev']);
  });

  it('cycles through the palette past its last color', () => {
    const lines = Array.from(
      { length: TAG_PALETTE.length + 1 },
      (_unused, index) => `${String(index + 1)};T;;;7;;;tag${String(index)}`,
    );
    const { project: rebuilt } = importLines(...lines);
    expect(rebuilt.tags.at(-1)?.color).toBe(TAG_PALETTE[0]);
  });

  it('imports a table with only a header as an empty project', () => {
    const imported = importFrench(`${HEADER}\n`);
    expect(imported.ok && imported.value.project.tasks).toEqual([]);
  });

  it('imports a project exported with another calendar, warning about the dates that move', () => {
    const everyDay = project(
      [workTask('a', { segments: [{ durationHours: 20, gapDaysBefore: 0 }] })],
      [],
      {
        calendar: { ...DEFAULT_CALENDAR, workingWeekdays: [0, 1, 2, 3, 4, 5, 6] },
        startDate: at(2026, 10, 3, 9),
      },
    );
    const imported = importFrench(
      unwrap(exportProjectCsv(everyDay, scheduleOrThrow(everyDay), FRENCH)),
    );
    expect(imported.ok && imported.value.warnings).toEqual([
      { path: 'rows[2].start', code: 'START_DIFFERS' },
      { path: 'rows[2].end', code: 'END_DIFFERS' },
    ]);
  });

  it('reads dates in the order of the format it is given, whatever wrote the file', () => {
    const imported = importProjectCsv(`${HEADER}\n1;A;25/10/2026;;7`, {
      format: AMERICAN,
      projectName: 'Imported',
      fallbackStart: FALLBACK_START,
    });
    expect(imported).toEqual({
      ok: false,
      error: [{ path: 'rows[2].start', code: 'INVALID_DATE' }],
    });
  });

  it(
    'accepts as many rows as the task limit, blank lines not counting',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const imported = importFrench(`Name;Duration${'\nA;7\n'.repeat(MAX_TASKS)}`);
      expect(imported.ok && imported.value.project.tasks.length).toBe(MAX_TASKS);
    },
  );
});

describe('importProjectCsv refusing a table', () => {
  it.each<[string, readonly string[], readonly ValidationIssue[]]>([
    [
      'a missing duration',
      ['1;A;28/09/2026'],
      [{ path: 'rows[2].duration', code: 'MISSING_FIELD' }],
    ],
    [
      'an unreadable number',
      ['1;A;;;seven'],
      [{ path: 'rows[2].duration', code: 'INVALID_NUMBER' }],
    ],
    [
      'an unreadable date',
      ['1;A;31/02/2026;;7'],
      [{ path: 'rows[2].start', code: 'INVALID_DATE' }],
    ],
    ['an unreadable WBS number', ['1.;A;;;7'], [{ path: 'rows[2].wbs', code: 'INVALID_NOTATION' }]],
    [
      'a repeated WBS number',
      ['1;A;;;7', '1;B;;;7'],
      [{ path: 'rows[3].wbs', code: 'DUPLICATE_ENTRY' }],
    ],
    [
      'a missing WBS number',
      ['1;A;;;7', ';B;;;7'],
      [{ path: 'rows[3].wbs', code: 'MISSING_FIELD' }],
    ],
    [
      'a WBS number without parent',
      ['2.1;A;;;7'],
      [{ path: 'rows[2].wbs', code: 'UNKNOWN_REFERENCE' }],
    ],
    [
      'an unknown predecessor',
      ['1;A;;;7;;9'],
      [{ path: 'rows[2].predecessors', code: 'UNKNOWN_REFERENCE' }],
    ],
    [
      'an unreadable predecessor',
      ['1;A;;;7;;1XX'],
      [{ path: 'rows[2].predecessors', code: 'INVALID_NOTATION' }],
    ],
    [
      'blocks that contradict the duration',
      ['1;A;;;8;;;;"4h; +1d 3h"'],
      [{ path: 'rows[2].duration', code: 'DURATION_MISMATCH' }],
    ],
    [
      'unreadable blocks',
      ['1;A;;;;;;;"4h; 3h"'],
      [{ path: 'rows[2].blocks', code: 'INVALID_NOTATION' }],
    ],
    ['an empty name', ['1; ;;;7'], [{ path: 'rows[2].name', code: 'EMPTY_TEXT' }]],
    [
      'a progress beyond 100',
      ['1;A;;;7;150'],
      [{ path: 'rows[2].progress', code: 'OUT_OF_RANGE' }],
    ],
    ['a half-done milestone', ['1;A;;;0;50'], [{ path: 'rows[2].progress', code: 'OUT_OF_RANGE' }]],
    [
      'a block longer than allowed',
      ['1;A;;;200000'],
      [{ path: 'rows[2].duration', code: 'OUT_OF_RANGE' }],
    ],
    [
      'a dependency on itself',
      ['1;A;;;7;;1'],
      [{ path: 'rows[2].predecessors', code: 'SELF_DEPENDENCY' }],
    ],
    [
      'a tag name too long',
      [`1;A;;;7;;;${'x'.repeat(51)}`],
      [{ path: 'rows[2].tag', code: 'TOO_LONG' }],
    ],
    ['a badly quoted cell', ['1;"A;;;7'], [{ path: 'rows[2]', code: 'INVALID_CSV' }]],
  ])('refuses %s at its row and column', (_label, lines, expected) => {
    expect(issuesOf(...lines)).toEqual(expected);
  });

  it('refuses blocks beyond the limits at the blocks column', () => {
    expect(issuesOf('1;A;;;;;;;"4h; +5000d 3h"')).toEqual([
      { path: 'rows[2].blocks', code: 'OUT_OF_RANGE' },
    ]);
  });

  it('refuses a project name the caller gives that is not a valid name', () => {
    const imported = importProjectCsv('Name;Duration\nA;7', {
      format: FRENCH,
      projectName: ' ',
      fallbackStart: FALLBACK_START,
    });
    expect(imported).toEqual({ ok: false, error: [{ path: 'name', code: 'EMPTY_TEXT' }] });
  });

  it('refuses a table whose schedule runs past the last supported year, before or after keeping start dates', () => {
    const chain = ['1;A;;;100000', '2;B;;;100000;;1', '3;C;;;100000;;2', '4;D;;;100000;;3'];
    expect(issuesOf(...chain)).toEqual([{ path: 'rows[5]', code: 'BEYOND_PLANNING_HORIZON' }]);
    expect(issuesOf('1;A;01/01/2026;;7', '2;B;01/01/2190;;100000')).toEqual([
      { path: 'rows[3]', code: 'BEYOND_PLANNING_HORIZON' },
    ]);
  });

  it('refuses a dependency cycle, a link to a summary and a repeated link at the rows concerned', () => {
    expect(issuesOf('1;A;;;7;;2', '2;B;;;7;;1')).toEqual([
      { path: 'rows[2]', code: 'DEPENDENCY_CYCLE' },
      { path: 'rows[3]', code: 'DEPENDENCY_CYCLE' },
    ]);
    expect(issuesOf('1;Phase;;;;;2', '1.1;A;;;7', '2;B;;;7')).toEqual([
      { path: 'rows[2].predecessors', code: 'SUMMARY_DEPENDENCY' },
    ]);
    expect(issuesOf('1;A;;;7', '2;B;;;7;;"1, 1SS"')).toEqual([
      { path: 'rows[3].predecessors', code: 'DUPLICATE_DEPENDENCY' },
    ]);
  });

  it('refuses more tags than allowed at the tag column', () => {
    const lines = Array.from(
      { length: MAX_TAGS + 1 },
      (_unused, index) => `${String(index + 1)};T;;;7;;;tag${String(index)}`,
    );
    expect(issuesOf(...lines)).toEqual([{ path: 'columns.tag', code: 'TOO_MANY_ITEMS' }]);
  });

  it('refuses more predecessors than allowed over the whole table, without building them all', () => {
    const many = (count: number) => Array.from({ length: count }, () => '1').join(',');
    const half = MAX_DEPENDENCIES / 2;
    expect(issuesOf('1;A;;;7', `2;B;;;7;;"${many(half)}"`, `3;C;;;7;;"${many(half + 1)}"`)).toEqual(
      [{ path: 'rows[4].predecessors', code: 'TOO_MANY_ITEMS' }],
    );
  });

  it('refuses a duration or progress column counted in another unit', () => {
    expect(importFrench('Name;Duration (days)\nA;5')).toEqual({
      ok: false,
      error: [{ path: 'columns.duration', code: 'UNSUPPORTED_UNIT' }],
    });
  });

  it('refuses a table without name column and a repeated column', () => {
    expect(importFrench('Duration;Start\n7;\n')).toEqual({
      ok: false,
      error: [{ path: 'columns.name', code: 'MISSING_FIELD' }],
    });
    expect(importFrench('Name;name\nA;B\n')).toEqual({
      ok: false,
      error: [{ path: 'columns.name', code: 'DUPLICATE_ENTRY' }],
    });
  });

  it('refuses too many columns or rows, and a text beyond the size limit, and only then', () => {
    const header = Array.from({ length: MAX_CSV_COLUMNS + 1 }, () => 'x').join(';');
    expect(importFrench(`${header}\n`)).toEqual({
      ok: false,
      error: [{ path: 'columns', code: 'TOO_MANY_ITEMS' }],
    });
    const rows = `Name;Duration${'\nA;7'.repeat(MAX_TASKS + 1)}`;
    expect(importFrench(rows)).toEqual({
      ok: false,
      error: [{ path: 'rows', code: 'TOO_MANY_ITEMS' }],
    });
    expect(importFrench(' '.repeat(MAX_CSV_TEXT_UTF16_UNITS + 1))).toEqual({
      ok: false,
      error: [{ path: '', code: 'TOO_LARGE' }],
    });
    expect(importFrench(' '.repeat(MAX_CSV_TEXT_UTF16_UNITS))).toEqual({
      ok: false,
      error: [{ path: 'columns.name', code: 'MISSING_FIELD' }],
    });
  });

  it('never throws on a random table', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    const cell = fc.string({
      unit: fc.constantFrom('1', '.', ';', '"', '\n', 'h', 'd', '+', '/', ' ', 'a', '%', '='),
    });
    fc.assert(
      fc.property(fc.array(cell, { maxLength: 40 }), (cells) => {
        expect(() => importFrench(`${HEADER}\n${cells.join(';')}`)).not.toThrow();
      }),
    );
  });
});
