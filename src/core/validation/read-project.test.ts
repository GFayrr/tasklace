import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_HIERARCHY_DEPTH,
  MAX_LAG_HOURS,
  MAX_REPORTED_ISSUES,
  MAX_SEGMENTS_PER_TASK,
  MAX_SEGMENT_GAP_DAYS,
  MAX_TAGS,
  MAX_TAG_NAME_LENGTH,
  MAX_TASKS,
  MAX_TASK_DURATION_HOURS,
  MAX_TASK_NAME_LENGTH,
} from '../limits';
import type { Project, Tag, Task } from '../model/project';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { at, dayOf } from '../testing/civil-time';
import { projectArbitrary } from '../testing/project-arbitrary';
import { link, milestone, project, splitTask, summary, workTask } from '../testing/project-builder';
import { scheduleProject } from '../scheduling/schedule-project';
import { END_PROJECT_HOUR, MAX_DAY_INDEX, MIN_DAY_INDEX, MIN_PROJECT_HOUR } from '../time';
import { readProject, STORED_VALUE_CODEC } from './read-project';
import type { ValidationIssue } from './validation-issues';

type Data = Record<string, unknown>;

const DESIGN_TAG: Tag = {
  id: 'design',
  name: 'Design',
  color: '#336699',
  representsPersonOrTeam: false,
};
const ALICE_TAG: Tag = {
  id: 'alice',
  name: 'Alice',
  color: '#aa5500',
  representsPersonOrTeam: true,
};

const RICH_PROJECT: Project = project(
  [
    summary('phase'),
    workTask('a', {
      name: 'Écrire le cahier des charges 📝',
      parentId: 'phase',
      tagId: 'design',
      progressPercent: 40,
      hoursPerDay: 4,
      dailyStartHour: 13,
      startNoEarlierThan: at(2026, 10, 1, 9),
      mustFinishOn: at(2026, 10, 9, 17),
      deadline: at(2026, 10, 12, 12),
    }),
    splitTask(
      'b',
      [
        [7, 0],
        [3, 2],
      ],
      { tagId: 'alice', sortKey: 'b0Zz' },
    ),
    milestone('m', { progressPercent: 100 }),
  ],
  [link('a', 'b', 'startToStart', -3), link('b', 'm', 'finishToFinish', 2)],
  {
    name: 'Rentrée 2026',
    tags: [DESIGN_TAG, ALICE_TAG],
    options: { criticalPathEnabled: true, dateConstraintsEnabled: true, alwaysShowPatterns: false },
    calendar: {
      workingWeekdays: [1, 2, 3, 4, 5, 6],
      workingTimeRanges: [
        { startHour: 13, endHour: 17 },
        { startHour: 8, endHour: 12 },
      ],
      nonWorkingPeriods: [
        { firstDay: dayOf(2026, 12, 24), lastDay: dayOf(2026, 12, 26) },
        { firstDay: dayOf(2027, 1, 1), lastDay: dayOf(2027, 1, 1) },
      ],
    },
  },
);

/** Turns a value into untyped plain data, as JSON parsing would produce it. */
function toData(value: unknown): Data {
  return JSON.parse(JSON.stringify(value)) as Data;
}

/** Returns the rich project as plain data with some top-level fields replaced. */
function projectWith(overrides: Data): Data {
  return { ...toData(RICH_PROJECT), ...overrides };
}

/** Returns the rich project as plain data with some fields of one task replaced. */
function taskWith(index: number, overrides: Data): Data {
  const tasks = toData(RICH_PROJECT.tasks) as unknown as Data[];
  tasks[index] = { ...tasks[index], ...overrides };
  return projectWith({ tasks });
}

/** Returns the rich project as plain data with some calendar fields replaced. */
function calendarWith(overrides: Data): Data {
  return projectWith({ calendar: { ...toData(RICH_PROJECT.calendar), ...overrides } });
}

/** Returns a copy of a record without one of its keys. */
function without(record: Data, key: string): Data {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

/** Returns the issues found in an input, or an empty list when it is a valid project. */
function issuesOf(input: unknown, rootPath?: string): readonly ValidationIssue[] {
  const result = readProject(input, STORED_VALUE_CODEC, rootPath);
  return result.ok ? [] : result.error;
}

/** Builds the single issue expected at a location. */
function issue(path: string, code: ValidationIssue['code']): ValidationIssue[] {
  return [{ path, code }];
}

describe('readProject: valid input', () => {
  it('accepts a project using every feature and returns an equal project', () => {
    expect(readProject(toData(RICH_PROJECT), STORED_VALUE_CODEC)).toEqual({
      ok: true,
      value: RICH_PROJECT,
    });
  });

  it('accepts an empty project', () => {
    expect(issuesOf(toData(project([])))).toEqual([]);
  });

  it('keeps a task pointing at an unknown tag, which is later treated as untagged', () => {
    expect(issuesOf(taskWith(1, { tagId: 'deleted' }))).toEqual([]);
  });

  it('accepts dates at both ends of the supported period', () => {
    expect(issuesOf(projectWith({ startDate: MIN_PROJECT_HOUR }))).toEqual([]);
    expect(issuesOf(projectWith({ startDate: END_PROJECT_HOUR - 1 }))).toEqual([]);
    const extremeDays = { firstDay: MIN_DAY_INDEX, lastDay: MAX_DAY_INDEX };
    expect(issuesOf(calendarWith({ nonWorkingPeriods: [extremeDays] }))).toEqual([]);
  });

  it('accepts every value at its limits', () => {
    const task = {
      name: '😀'.repeat(MAX_TASK_NAME_LENGTH),
      progressPercent: 100,
      hoursPerDay: 24,
      dailyStartHour: 0,
      segments: [
        { durationHours: MAX_TASK_DURATION_HOURS - MAX_SEGMENTS_PER_TASK + 1, gapDaysBefore: 0 },
        ...Array.from({ length: MAX_SEGMENTS_PER_TASK - 1 }, () => ({
          durationHours: 1,
          gapDaysBefore: MAX_SEGMENT_GAP_DAYS,
        })),
      ],
    };
    const dependencies = [
      { ...link('a', 'b'), lagHours: -MAX_LAG_HOURS },
      { ...link('b', 'm'), lagHours: MAX_LAG_HOURS },
    ];
    const tag = { ...DESIGN_TAG, name: 'x'.repeat(MAX_TAG_NAME_LENGTH) };
    const fullDay = {
      ...toData(RICH_PROJECT.calendar),
      workingTimeRanges: [{ startHour: 0, endHour: 24 }],
    };
    expect(
      issuesOf({ ...taskWith(1, task), dependencies, tags: [tag], calendar: fullDay }),
    ).toEqual([]);
  });

  it(
    'accepts every generated project after a trip through JSON and returns it unchanged',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(projectArbitrary, ({ project: input }) => {
          expect(readProject(toData(input), STORED_VALUE_CODEC)).toEqual({
            ok: true,
            value: input,
          });
        }),
      );
    },
  );
});

describe('readProject: shape of the data', () => {
  it('reports a missing project', () => {
    expect(issuesOf(undefined)).toEqual(issue('', 'MISSING_FIELD'));
  });

  it.each([null, [], 'project', 42, true])('rejects %p as a wrong type', (value) => {
    expect(issuesOf(value)).toEqual(issue('', 'WRONG_TYPE'));
  });

  it('reports every missing top-level field', () => {
    expect(issuesOf({}).map((found) => found.path)).toEqual([
      'name',
      'startDate',
      'calendar',
      'options',
      'tags',
      'tasks',
      'dependencies',
      'baseline',
    ]);
  });

  it('reports unknown fields at every level', () => {
    const data = projectWith({ extra: 1 });
    const calendar = data['calendar'] as Data;
    calendar['timeZone'] = 'UTC';
    (calendar['workingTimeRanges'] as Data[])[0] = { startHour: 13, endHour: 17, minutes: 0 };
    (calendar['nonWorkingPeriods'] as Data[])[0] = {
      firstDay: MIN_DAY_INDEX,
      lastDay: MIN_DAY_INDEX,
      label: 'x',
    };
    (data['options'] as Data)['darkMode'] = true;
    (data['tags'] as Data[])[0] = { ...DESIGN_TAG, pattern: 'dots' };
    (data['dependencies'] as Data[])[0] = { ...link('a', 'b'), note: '' };
    const tasks = data['tasks'] as Data[];
    tasks[1] = { ...tasks[1], segments: [{ durationHours: 1, gapDaysBefore: 0, unit: 'h' }] };
    expect(issuesOf(data)).toEqual([
      { path: 'extra', code: 'UNKNOWN_FIELD' },
      { path: 'calendar.timeZone', code: 'UNKNOWN_FIELD' },
      { path: 'calendar.workingTimeRanges[0].minutes', code: 'UNKNOWN_FIELD' },
      { path: 'calendar.nonWorkingPeriods[0].label', code: 'UNKNOWN_FIELD' },
      { path: 'options.darkMode', code: 'UNKNOWN_FIELD' },
      { path: 'tags[0].pattern', code: 'UNKNOWN_FIELD' },
      { path: 'tasks[1].segments[0].unit', code: 'UNKNOWN_FIELD' },
      { path: 'dependencies[0].note', code: 'UNKNOWN_FIELD' },
    ]);
  });

  it('reports an own __proto__ key as an unknown field without polluting objects', () => {
    const data = JSON.parse(
      JSON.stringify(toData(RICH_PROJECT)).replace('{', '{"__proto__":{"polluted":true},'),
    ) as unknown;
    expect(issuesOf(data)).toEqual(issue('__proto__', 'UNKNOWN_FIELD'));
    expect(({} as Data)['polluted']).toBeUndefined();
  });

  it('prefixes every location with the root path', () => {
    expect(issuesOf(projectWith({ name: '' }), 'project')).toEqual(
      issue('project.name', 'EMPTY_TEXT'),
    );
    expect(issuesOf(calendarWith({ workingWeekdays: [] }), 'project')).toEqual(
      issue('project.calendar.workingWeekdays', 'NO_WORKING_WEEKDAY'),
    );
  });

  it('rejects oversized lists before reading their items', () => {
    expect(issuesOf(projectWith({ tasks: new Array(MAX_TASKS + 1).fill(null) }))).toEqual(
      issue('tasks', 'TOO_MANY_ITEMS'),
    );
    expect(issuesOf(projectWith({ tags: new Array(MAX_TAGS + 1).fill(null) }))).toEqual(
      issue('tags', 'TOO_MANY_ITEMS'),
    );
  });

  it('stops reporting at the limit of reported issues', () => {
    const tasks = Array.from({ length: MAX_REPORTED_ISSUES * 3 }, () => 'not a task');
    expect(issuesOf(projectWith({ tasks }))).toHaveLength(MAX_REPORTED_ISSUES);
  });

  it('never throws on arbitrary input', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withObjectString: true }), (value) => {
        expect(readProject(value, STORED_VALUE_CODEC).ok).toBe(false);
      }),
    );
  });

  it(
    'never throws when one field of a valid project is replaced by any JSON value',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const base = toData(RICH_PROJECT);
      const keys = Object.keys(base);
      fc.assert(
        fc.property(fc.constantFrom(...keys), fc.jsonValue(), (key, value) => {
          expect(() => readProject({ ...base, [key]: value }, STORED_VALUE_CODEC)).not.toThrow();
        }),
      );
    },
  );
});

describe('readProject: values', () => {
  it.each([
    [{ name: '' }, 'name', 'EMPTY_TEXT'],
    [{ name: 'a\nb' }, 'name', 'INVALID_TEXT'],
    [{ name: 'x'.repeat(101) }, 'name', 'TOO_LONG'],
    [{ startDate: MIN_PROJECT_HOUR - 1 }, 'startDate', 'OUT_OF_RANGE'],
    [{ startDate: END_PROJECT_HOUR }, 'startDate', 'OUT_OF_RANGE'],
    [{ startDate: 1.3 }, 'startDate', 'WRONG_TYPE'],
    [{ startDate: '2026-09-28T09:00' }, 'startDate', 'WRONG_TYPE'],
    [
      { options: { ...RICH_PROJECT.options, criticalPathEnabled: 1 } },
      'options.criticalPathEnabled',
      'WRONG_TYPE',
    ],
  ] as const)('rejects %j at %s', (overrides, path, code) => {
    expect(issuesOf(projectWith(overrides))).toEqual(issue(path, code));
  });

  it.each([
    [{ workingWeekdays: [7] }, 'calendar.workingWeekdays[0]', 'OUT_OF_RANGE'],
    [{ workingWeekdays: [0, 1, 2, 3, 4, 5, 6, 0] }, 'calendar.workingWeekdays', 'TOO_MANY_ITEMS'],
    [{ workingWeekdays: [1, 2, 1] }, 'calendar.workingWeekdays[2]', 'DUPLICATE_WEEKDAY'],
    [{ workingWeekdays: [] }, 'calendar.workingWeekdays', 'NO_WORKING_WEEKDAY'],
    [{ workingTimeRanges: [] }, 'calendar.workingTimeRanges', 'NO_WORKING_TIME_RANGE'],
    [
      { workingTimeRanges: [{ startHour: 24, endHour: 24 }] },
      'calendar.workingTimeRanges[0].startHour',
      'OUT_OF_RANGE',
    ],
    [
      { workingTimeRanges: [{ startHour: 0, endHour: 25 }] },
      'calendar.workingTimeRanges[0].endHour',
      'OUT_OF_RANGE',
    ],
    [
      { workingTimeRanges: [{ startHour: 10, endHour: 10 }] },
      'calendar.workingTimeRanges[0]',
      'INVALID_WORKING_TIME_RANGE',
    ],
    [
      {
        workingTimeRanges: [
          { startHour: 8, endHour: 12 },
          { startHour: 11, endHour: 14 },
        ],
      },
      'calendar.workingTimeRanges',
      'OVERLAPPING_WORKING_TIME_RANGES',
    ],
    [
      { nonWorkingPeriods: [{ firstDay: MAX_DAY_INDEX, lastDay: MAX_DAY_INDEX + 1 }] },
      'calendar.nonWorkingPeriods[0].lastDay',
      'OUT_OF_RANGE',
    ],
    [
      { nonWorkingPeriods: [{ firstDay: 20_000, lastDay: 19_999 }] },
      'calendar.nonWorkingPeriods[0]',
      'INVALID_NON_WORKING_PERIOD',
    ],
  ] as const)('rejects the calendar %j at %s', (overrides, path, code) => {
    expect(issuesOf(calendarWith(overrides))).toEqual(issue(path, code));
  });

  it.each([
    [{ id: 'bad id' }, 'tags[0].id', 'INVALID_IDENTIFIER'],
    [{ name: ' ' }, 'tags[0].name', 'EMPTY_TEXT'],
    [{ name: 'x'.repeat(MAX_TAG_NAME_LENGTH + 1) }, 'tags[0].name', 'TOO_LONG'],
    [{ color: '#12345' }, 'tags[0].color', 'INVALID_COLOR'],
    [{ color: '#GGGGGG' }, 'tags[0].color', 'INVALID_COLOR'],
    [{ color: 'red' }, 'tags[0].color', 'INVALID_COLOR'],
    [{ color: 0x336699 }, 'tags[0].color', 'WRONG_TYPE'],
    [{ representsPersonOrTeam: 'yes' }, 'tags[0].representsPersonOrTeam', 'WRONG_TYPE'],
  ] as const)('rejects the tag %j at %s', (overrides, path, code) => {
    expect(issuesOf(projectWith({ tags: [{ ...DESIGN_TAG, ...overrides }] }))).toEqual(
      issue(path, code),
    );
  });

  it.each([
    [{ id: 'a/b' }, 'dependencies[0].id', 'INVALID_IDENTIFIER'],
    [{ predecessorId: '' }, 'dependencies[0].predecessorId', 'INVALID_IDENTIFIER'],
    [{ type: 'FS' }, 'dependencies[0].type', 'OUT_OF_RANGE'],
    [{ lagHours: MAX_LAG_HOURS + 1 }, 'dependencies[0].lagHours', 'OUT_OF_RANGE'],
    [{ lagHours: 0.3 }, 'dependencies[0].lagHours', 'WRONG_TYPE'],
    [{ predecessorBlock: -1 }, 'dependencies[0].predecessorBlock', 'OUT_OF_RANGE'],
    [{ predecessorBlock: 1.5 }, 'dependencies[0].predecessorBlock', 'WRONG_TYPE'],
    [{ successorBlock: '1' }, 'dependencies[0].successorBlock', 'WRONG_TYPE'],
    [{ successorBlock: true }, 'dependencies[0].successorBlock', 'WRONG_TYPE'],
    [{ successorBlock: MAX_SEGMENTS_PER_TASK }, 'dependencies[0].successorBlock', 'OUT_OF_RANGE'],
  ] as const)('rejects the dependency %j at %s', (overrides, path, code) => {
    expect(issuesOf(projectWith({ dependencies: [{ ...link('a', 'b'), ...overrides }] }))).toEqual(
      issue(path, code),
    );
  });
});

describe('readProject: links to blocks', () => {
  it('reads a missing block reference as the whole task', () => {
    const { id, predecessorId, successorId, type, lagHours } = link('a', 'b');
    const bare = { id, predecessorId, successorId, type, lagHours };
    const result = readProject(projectWith({ dependencies: [bare] }), STORED_VALUE_CODEC);
    expect(result.ok && result.value.dependencies).toEqual([link('a', 'b')]);
  });
});

describe('readProject: tasks', () => {
  it.each([
    [1, { progressPercent: -1 }, 'tasks[1].progressPercent', 'OUT_OF_RANGE'],
    [1, { progressPercent: 101 }, 'tasks[1].progressPercent', 'OUT_OF_RANGE'],
    [1, { progressPercent: 50.5 }, 'tasks[1].progressPercent', 'WRONG_TYPE'],
    [3, { progressPercent: 50 }, 'tasks[3].progressPercent', 'OUT_OF_RANGE'],
    [1, { hoursPerDay: 0 }, 'tasks[1].hoursPerDay', 'OUT_OF_RANGE'],
    [1, { hoursPerDay: 25 }, 'tasks[1].hoursPerDay', 'OUT_OF_RANGE'],
    [1, { dailyStartHour: 24 }, 'tasks[1].dailyStartHour', 'OUT_OF_RANGE'],
    [1, { dailyStartHour: -1 }, 'tasks[1].dailyStartHour', 'OUT_OF_RANGE'],
    [1, { parentId: 'no way' }, 'tasks[1].parentId', 'INVALID_IDENTIFIER'],
    [1, { tagId: 7 }, 'tasks[1].tagId', 'WRONG_TYPE'],
    [1, { sortKey: 'a-b' }, 'tasks[1].sortKey', 'INVALID_IDENTIFIER'],
    [1, { sortKey: 'a'.repeat(129) }, 'tasks[1].sortKey', 'INVALID_IDENTIFIER'],
    [1, { deadline: END_PROJECT_HOUR }, 'tasks[1].deadline', 'OUT_OF_RANGE'],
    [3, { mustFinishOn: -1 }, 'tasks[3].mustFinishOn', 'OUT_OF_RANGE'],
    [2, { startNoEarlierThan: '2026' }, 'tasks[2].startNoEarlierThan', 'WRONG_TYPE'],
    [1, { segments: [] }, 'tasks[1].segments', 'EMPTY_LIST'],
    [1, { segments: {} }, 'tasks[1].segments', 'WRONG_TYPE'],
    [
      1,
      {
        segments: new Array(MAX_SEGMENTS_PER_TASK + 1).fill({ durationHours: 1, gapDaysBefore: 1 }),
      },
      'tasks[1].segments',
      'TOO_MANY_ITEMS',
    ],
    [
      1,
      { segments: [{ durationHours: 1, gapDaysBefore: 1 }] },
      'tasks[1].segments[0].gapDaysBefore',
      'OUT_OF_RANGE',
    ],
    [
      1,
      {
        segments: [
          { durationHours: 1, gapDaysBefore: 0 },
          { durationHours: 1, gapDaysBefore: -1 },
        ],
      },
      'tasks[1].segments[1].gapDaysBefore',
      'OUT_OF_RANGE',
    ],
    [
      1,
      {
        segments: [
          { durationHours: 1, gapDaysBefore: 0 },
          { durationHours: 1, gapDaysBefore: MAX_SEGMENT_GAP_DAYS + 1 },
        ],
      },
      'tasks[1].segments[1].gapDaysBefore',
      'OUT_OF_RANGE',
    ],
    [
      1,
      { segments: [{ durationHours: 0, gapDaysBefore: 0 }] },
      'tasks[1].segments[0].durationHours',
      'OUT_OF_RANGE',
    ],
    [
      1,
      { segments: [{ durationHours: MAX_TASK_DURATION_HOURS + 1, gapDaysBefore: 0 }] },
      'tasks[1].segments[0].durationHours',
      'OUT_OF_RANGE',
    ],
    [1, { name: 'x'.repeat(MAX_TASK_NAME_LENGTH + 1) }, 'tasks[1].name', 'TOO_LONG'],
  ] as const)('rejects task %i changed to %j at %s', (index, overrides, path, code) => {
    expect(issuesOf(taskWith(index, overrides))).toEqual(issue(path, code));
  });

  it('accepts a milestone that is either not started or done', () => {
    expect(issuesOf(taskWith(3, { progressPercent: 0 }))).toEqual([]);
    expect(issuesOf(taskWith(3, { progressPercent: 100 }))).toEqual([]);
  });

  it('reports a missing, mistyped or unknown kind', () => {
    const tasks = toData(RICH_PROJECT.tasks) as unknown as Data[];
    expect(issuesOf(projectWith({ tasks: [without(tasks[1] ?? {}, 'kind')] }))).toEqual(
      issue('tasks[0].kind', 'MISSING_FIELD'),
    );
    expect(issuesOf(taskWith(1, { kind: 1 }))).toEqual(issue('tasks[1].kind', 'WRONG_TYPE'));
    expect(issuesOf(taskWith(1, { kind: 'phase' }))).toEqual(
      issue('tasks[1].kind', 'OUT_OF_RANGE'),
    );
  });

  it('reports unknown fields even when the kind is invalid', () => {
    expect(issuesOf(taskWith(1, { kind: 'phase', color: 'red' }))).toEqual([
      { path: 'tasks[1].kind', code: 'OUT_OF_RANGE' },
      { path: 'tasks[1].color', code: 'UNKNOWN_FIELD' },
    ]);
  });

  it.each([null, 'task', 3, []])('rejects the task %p as a wrong type', (value) => {
    expect(issuesOf(projectWith({ tasks: [value] }))).toEqual(issue('tasks[0]', 'WRONG_TYPE'));
  });

  it('rejects items of nested lists that are not objects', () => {
    expect(issuesOf(taskWith(1, { segments: [7] }))).toEqual(
      issue('tasks[1].segments[0]', 'WRONG_TYPE'),
    );
    expect(issuesOf(calendarWith({ workingTimeRanges: ['09-17'] }))).toEqual(
      issue('calendar.workingTimeRanges[0]', 'WRONG_TYPE'),
    );
    expect(issuesOf(calendarWith({ nonWorkingPeriods: [null] }))).toEqual(
      issue('calendar.nonWorkingPeriods[0]', 'WRONG_TYPE'),
    );
    expect(issuesOf(projectWith({ dependencies: ['a-b'] }))).toEqual(
      issue('dependencies[0]', 'WRONG_TYPE'),
    );
  });

  it('rejects a summary task with an invalid field', () => {
    expect(issuesOf(taskWith(0, { name: '' }))).toEqual(issue('tasks[0].name', 'EMPTY_TEXT'));
  });

  it('only allows the fields of the kind of each task', () => {
    expect(issuesOf(taskWith(0, { progressPercent: 0 }))).toEqual(
      issue('tasks[0].progressPercent', 'UNKNOWN_FIELD'),
    );
    expect(issuesOf(taskWith(3, { hoursPerDay: 7 }))).toEqual(
      issue('tasks[3].hoursPerDay', 'UNKNOWN_FIELD'),
    );
    expect(issuesOf(taskWith(1, { kind: 'milestone' }))).toEqual([
      { path: 'tasks[1].segments', code: 'UNKNOWN_FIELD' },
      { path: 'tasks[1].hoursPerDay', code: 'UNKNOWN_FIELD' },
      { path: 'tasks[1].dailyStartHour', code: 'UNKNOWN_FIELD' },
      { path: 'tasks[1].progressPercent', code: 'OUT_OF_RANGE' },
    ]);
  });

  it('reports every missing field of a work task', () => {
    const paths = issuesOf(projectWith({ tasks: [{ kind: 'task' }] })).map((found) => found.path);
    expect(paths).toEqual([
      'tasks[0].id',
      'tasks[0].name',
      'tasks[0].parentId',
      'tasks[0].sortKey',
      'tasks[0].progressPercent',
      'tasks[0].tagId',
      'tasks[0].startNoEarlierThan',
      'tasks[0].mustFinishOn',
      'tasks[0].deadline',
      'tasks[0].segments',
      'tasks[0].hoursPerDay',
      'tasks[0].dailyStartHour',
    ]);
  });
});

describe('readProject: structure', () => {
  /** Returns the structure issues of a project built from tasks, dependencies and tags. */
  function structureIssues(
    tasks: readonly Task[],
    dependencies = [link('a', 'b')],
    tags: readonly Tag[] = [],
  ): readonly ValidationIssue[] {
    return issuesOf(toData(project(tasks, dependencies, { tags })));
  }

  it('points a duplicated task identifier at its repeated occurrence', () => {
    expect(structureIssues([workTask('a'), workTask('b'), workTask('a')])).toEqual(
      issue('tasks[2]', 'DUPLICATE_TASK_ID'),
    );
  });

  it('points hierarchy problems at the faulty task', () => {
    expect(structureIssues([workTask('a'), workTask('b', { parentId: 'x' })])).toEqual(
      issue('tasks[1]', 'UNKNOWN_PARENT'),
    );
    expect(structureIssues([workTask('a'), workTask('b', { parentId: 'a' })])).toEqual(
      issue('tasks[1]', 'PARENT_NOT_SUMMARY'),
    );
    expect(
      structureIssues([
        summary('s', { parentId: 't' }),
        summary('t', { parentId: 's' }),
        workTask('a'),
        workTask('b'),
      ]),
    ).toEqual([
      { path: 'tasks[0]', code: 'HIERARCHY_CYCLE' },
      { path: 'tasks[1]', code: 'HIERARCHY_CYCLE' },
    ]);
  });

  it('reports a hierarchy deeper than the limit', () => {
    const summaries = Array.from({ length: MAX_HIERARCHY_DEPTH + 1 }, (_value, index) =>
      summary(`s${String(index)}`, { parentId: index === 0 ? null : `s${String(index - 1)}` }),
    );
    const found = structureIssues([...summaries, workTask('a'), workTask('b')]);
    expect(found.map((item) => item.code)).toContain('HIERARCHY_TOO_DEEP');
  });

  it('points dependency problems at the faulty dependency', () => {
    const tasks = [summary('s'), workTask('a'), workTask('b')];
    expect(structureIssues(tasks, [link('a', 'b'), link('a', 'x')])).toEqual(
      issue('dependencies[1]', 'UNKNOWN_DEPENDENCY_TASK'),
    );
    expect(structureIssues(tasks, [link('a', 'a')])).toEqual(
      issue('dependencies[0]', 'SELF_DEPENDENCY'),
    );
    expect(structureIssues(tasks, [link('s', 'b')])).toEqual(
      issue('dependencies[0]', 'SUMMARY_DEPENDENCY'),
    );
    expect(structureIssues(tasks, [link('a', 'b'), { ...link('a', 'b'), id: 'again' }])).toEqual(
      issue('dependencies[1]', 'DUPLICATE_DEPENDENCY'),
    );
  });

  it('points a duplicated dependency identifier at its repeated occurrence', () => {
    const tasks = [workTask('a'), workTask('b'), workTask('c')];
    expect(structureIssues(tasks, [link('a', 'b'), { ...link('b', 'c'), id: 'a-b' }])).toEqual(
      issue('dependencies[1]', 'DUPLICATE_DEPENDENCY_ID'),
    );
  });

  it('reports every task caught in a dependency cycle', () => {
    const tasks = [workTask('a'), workTask('b'), workTask('c'), workTask('free')];
    expect(structureIssues(tasks, [link('a', 'b'), link('b', 'c'), link('c', 'a')])).toEqual([
      { path: 'tasks[0]', code: 'DEPENDENCY_CYCLE' },
      { path: 'tasks[1]', code: 'DEPENDENCY_CYCLE' },
      { path: 'tasks[2]', code: 'DEPENDENCY_CYCLE' },
    ]);
  });

  it('points a duplicated tag identifier at its repeated occurrence', () => {
    const tasks = [workTask('a'), workTask('b')];
    expect(structureIssues(tasks, [], [ALICE_TAG, DESIGN_TAG, ALICE_TAG])).toEqual(
      issue('tags[2]', 'DUPLICATE_TAG_ID'),
    );
  });

  it('only checks the structure once every field is valid', () => {
    const tasks = [workTask('a'), workTask('a', { progressPercent: 101 })];
    expect(issuesOf(toData(project(tasks)))).toEqual(
      issue('tasks[1].progressPercent', 'OUT_OF_RANGE'),
    );
  });

  it('rejects hours per day beyond the working day of the project', () => {
    expect(issuesOf(toData(project([workTask('a', { hoursPerDay: 7 })])))).toEqual([]);
    expect(issuesOf(toData(project([workTask('a', { hoursPerDay: 8 })])))).toEqual(
      issue('tasks[0].hoursPerDay', 'INVALID_HOURS_PER_DAY'),
    );
  });

  it('rejects a daily start hour leaving too few working hours in the day', () => {
    const fitting = workTask('a', { hoursPerDay: 3, dailyStartHour: 14 });
    expect(issuesOf(toData(project([fitting])))).toEqual([]);
    const late = workTask('a', { hoursPerDay: 3, dailyStartHour: 16 });
    expect(issuesOf(toData(project([milestone('m'), late])))).toEqual(
      issue('tasks[1].dailyStartHour', 'INVALID_DAILY_START_HOUR'),
    );
  });

  it('skips the daily pattern check when the calendar is invalid', () => {
    const data = toData(project([workTask('a', { hoursPerDay: 8 })]));
    (data['calendar'] as Data)['workingWeekdays'] = [];
    expect(issuesOf(data)).toEqual(issue('calendar.workingWeekdays', 'NO_WORKING_WEEKDAY'));
  });

  it('reports calendar and structure problems together', () => {
    const data = toData(project([workTask('a'), workTask('a')]));
    (data['calendar'] as Data)['workingWeekdays'] = [];
    expect(issuesOf(data)).toEqual([
      { path: 'calendar.workingWeekdays', code: 'NO_WORKING_WEEKDAY' },
      { path: 'tasks[1]', code: 'DUPLICATE_TASK_ID' },
    ]);
  });

  it('stops reporting structure problems at the limit of reported issues', () => {
    const tasks = Array.from({ length: MAX_REPORTED_ISSUES * 2 }, () => workTask('same'));
    expect(structureIssues(tasks, [])).toHaveLength(MAX_REPORTED_ISSUES);
  });
});

describe('readProject: holes, totals and scheduling', () => {
  it('reports holes in lists as missing items', () => {
    expect(issuesOf(projectWith({ tasks: new Array(1) }))).toEqual(
      issue('tasks[0]', 'MISSING_FIELD'),
    );
    expect(issuesOf(taskWith(1, { segments: new Array(2) }))).toEqual([
      { path: 'tasks[1].segments[0]', code: 'MISSING_FIELD' },
      { path: 'tasks[1].segments[1]', code: 'MISSING_FIELD' },
    ]);
  });

  it('rejects blocks whose total duration exceeds the maximum task duration', () => {
    const segments = [
      { durationHours: MAX_TASK_DURATION_HOURS, gapDaysBefore: 0 },
      { durationHours: 1, gapDaysBefore: 1 },
    ];
    expect(issuesOf(taskWith(1, { segments }))).toEqual(issue('tasks[1].segments', 'OUT_OF_RANGE'));
  });

  it('ends the issues with TOO_MANY_ISSUES when some are left out', () => {
    const tasks = Array.from({ length: MAX_REPORTED_ISSUES * 3 }, () => 'not a task');
    expect(issuesOf(projectWith({ tasks })).at(-1)).toEqual({ path: '', code: 'TOO_MANY_ISSUES' });
  });

  it.each([
    [
      'blocks spread far beyond the planning period',
      taskWith(1, {
        segments: [
          { durationHours: 1, gapDaysBefore: 0 },
          ...Array.from({ length: MAX_SEGMENTS_PER_TASK - 1 }, () => ({
            durationHours: 1,
            gapDaysBefore: MAX_SEGMENT_GAP_DAYS,
          })),
        ],
      }),
    ],
    [
      'a calendar without any working day',
      calendarWith({ nonWorkingPeriods: [{ firstDay: MIN_DAY_INDEX, lastDay: MAX_DAY_INDEX }] }),
    ],
  ])('accepts %s and lets scheduling fail with a typed error', (_label, data) => {
    const read = readProject(data, STORED_VALUE_CODEC);
    if (!read.ok) {
      throw new Error(JSON.stringify(read.error));
    }
    expect(scheduleProject(read.value).ok).toBe(false);
  });
});

describe('readProject: baseline', () => {
  const entry = {
    taskId: 'a',
    start: at(2026, 9, 28, 9),
    end: at(2026, 9, 28, 17),
    durationHours: 7,
  };
  const withBaseline = (entries: readonly unknown[]): Data =>
    projectWith({ baseline: { takenAt: at(2026, 9, 27, 18), entries } });

  it('accepts a baseline, even with an entry for a task deleted since', () => {
    expect(issuesOf(withBaseline([entry, { ...entry, taskId: 'deleted' }]))).toEqual([]);
  });

  it('rejects an entry ending before it starts', () => {
    expect(issuesOf(withBaseline([{ ...entry, end: entry.start - 1 }]))).toEqual(
      issue('baseline.entries[0].end', 'OUT_OF_RANGE'),
    );
  });

  it('rejects two entries for the same task', () => {
    expect(issuesOf(withBaseline([entry, entry]))).toEqual(
      issue('baseline.entries[1]', 'DUPLICATE_ENTRY'),
    );
  });

  it('rejects missing, unknown and out of range baseline fields', () => {
    expect(issuesOf(projectWith({ baseline: { entries: [] } }))).toEqual(
      issue('baseline.takenAt', 'MISSING_FIELD'),
    );
    expect(issuesOf(withBaseline([{ ...entry, progress: 0 }]))).toEqual(
      issue('baseline.entries[0].progress', 'UNKNOWN_FIELD'),
    );
    expect(issuesOf(withBaseline([{ ...entry, durationHours: -1 }]))).toEqual(
      issue('baseline.entries[0].durationHours', 'OUT_OF_RANGE'),
    );
  });
});
