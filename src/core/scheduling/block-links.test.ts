import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compileCalendar } from '../calendar/compile-calendar';
import { lastWorkingHourEnd, shiftWorkingHours } from '../calendar/working-time';
import type { Dependency, DependencyType, Project, WorkTask } from '../model/project';
import { PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../testing/arbitraries';
import { at } from '../testing/civil-time';
import { projectArbitrary } from '../testing/project-arbitrary';
import {
  blockLink,
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  workTask,
} from '../testing/project-builder';
import { blockPairKey, shortestLink } from './block-links';
import { analyzeProjectStructure } from './project-structure';
import { constrainsSuccessorStart, dependencyAnchor, resumeAfter } from './forward-pass';
import { scheduleProject, type Schedule } from './schedule-project';
import type { ScheduledSegment } from './task-placement';

const DEVELOPMENT = splitTask('dev', [
  [7, 0],
  [7, 0],
]);
const TEST = workTask('test');

/** Returns the blocks of a task in a schedule. */
function blocksOf(schedule: Schedule, id: string): readonly ScheduledSegment[] {
  return schedule.placements.get(id)?.segments ?? [];
}

describe('shortestLink', () => {
  it('writes a named block as the whole task when the whole task stands for it anyway', () => {
    expect(shortestLink(blockLink('dev', 'test', { from: 1 }), DEVELOPMENT, TEST)).toEqual({
      ...blockLink('dev', 'test', { from: 1 }),
      predecessorBlock: null,
    });
    expect(
      shortestLink(blockLink('test', 'dev', { to: 0 }), TEST, DEVELOPMENT).successorBlock,
    ).toBeNull();
    expect(
      shortestLink(blockLink('test', 'dev', { to: 1 }, 'finishToFinish'), TEST, DEVELOPMENT)
        .successorBlock,
    ).toBeNull();
  });

  it('keeps a named block that the whole task would not stand for', () => {
    const fromFirst = blockLink('dev', 'test', { from: 0 });
    expect(shortestLink(fromFirst, DEVELOPMENT, TEST)).toBe(fromFirst);
    const toLast = blockLink('test', 'dev', { to: 1 });
    expect(shortestLink(toLast, TEST, DEVELOPMENT)).toBe(toLast);
  });
});

describe('duplicate links', () => {
  it('finds a duplicate exactly when the two links join the same tasks or blocks', () => {
    const tasks: readonly WorkTask[] = [
      DEVELOPMENT,
      TEST,
      splitTask('review', [
        [2, 0],
        [2, 0],
        [2, 0],
      ]),
    ];
    const end = fc.record({ task: fc.nat({ max: 2 }), block: fc.option(fc.nat({ max: 2 })) });
    const linkShape = fc.record({ from: end, to: end, type: fc.constantFrom(...TYPES) });
    const blockIn = (task: WorkTask, block: number | null) =>
      block !== null && task.segments.length > 1 && block < task.segments.length ? block : null;
    const toLink = (
      shape: typeof linkShape extends fc.Arbitrary<infer T> ? T : never,
      id: string,
    ) => {
      const from = tasks[shape.from.task] ?? TEST;
      const to = tasks[shape.to.task] ?? TEST;
      return {
        id,
        predecessorId: from.id,
        predecessorBlock: blockIn(from, shape.from.block),
        successorId: to.id,
        successorBlock: blockIn(to, shape.to.block),
        type: shape.type,
        lagHours: 0,
      };
    };
    fc.assert(
      fc.property(linkShape, linkShape, (first, second) => {
        const one = toLink(first, 'one');
        const two = toLink(second, 'two');
        fc.pre(one.predecessorId !== one.successorId && two.predecessorId !== two.successorId);
        const structure = analyzeProjectStructure(project(tasks, [one, two]));
        const codes = structure.ok ? [] : structure.error.map((error) => error.code);
        expect(codes.includes('DUPLICATE_DEPENDENCY')).toBe(
          blockPairKey(one) === blockPairKey(two),
        );
      }),
    );
  });
});

describe('links to and from blocks', () => {
  it('fits a task between two blocks of another, which then looks split', () => {
    const plan = project(
      [DEVELOPMENT, TEST],
      [blockLink('dev', 'test', { from: 0 }), blockLink('test', 'dev', { to: 1 })],
    );
    const schedule = scheduleOrThrow(plan);
    expect(blocksOf(schedule, 'dev')).toEqual([
      { start: at(2026, 9, 28, 9), end: at(2026, 9, 28, 17) },
      { start: at(2026, 9, 30, 9), end: at(2026, 9, 30, 17) },
    ]);
    expect(schedule.placements.get('test')).toMatchObject({
      start: at(2026, 9, 29, 9),
      end: at(2026, 9, 29, 17),
    });
  });

  it('keeps the gap in days of a block as a minimum, even when what it waits for ends sooner', () => {
    const plan = project(
      [
        splitTask('dev', [
          [7, 0],
          [7, 3],
        ]),
        workTask('test', { segments: [{ durationHours: 2, gapDaysBefore: 0 }] }),
      ],
      [blockLink('dev', 'test', { from: 0 }), blockLink('test', 'dev', { to: 1 })],
    );
    expect(blocksOf(scheduleOrThrow(plan), 'dev')[1]?.start).toBe(at(2026, 10, 1, 9));
  });

  it('lets a task wait for the start of a block, and a lag move it', () => {
    const plan = project(
      [DEVELOPMENT, TEST, workTask('review')],
      [
        blockLink('dev', 'test', { from: 0 }),
        blockLink('test', 'dev', { to: 1 }),
        blockLink('dev', 'review', { from: 1 }, 'startToStart', 2),
      ],
    );
    expect(scheduleOrThrow(plan).placements.get('review')?.start).toBe(at(2026, 9, 30, 11));
  });

  it('makes only the last block of a split task wait for a finish-to-finish link, the pause growing', () => {
    const late = workTask('late', { startNoEarlierThan: at(2026, 10, 5, 9) });
    const plan = project([late, DEVELOPMENT], [link('late', 'dev', 'finishToFinish')]);
    const blocks = blocksOf(scheduleOrThrow(plan), 'dev');
    expect(blocks[0]?.start).toBe(at(2026, 9, 28, 9));
    expect(blocks[1]?.end).toBe(at(2026, 10, 5, 17));
  });

  it('finds the critical path through the blocks', () => {
    const plan = project(
      [DEVELOPMENT, TEST],
      [blockLink('dev', 'test', { from: 0 }), blockLink('test', 'dev', { to: 1 })],
      {
        options: {
          criticalPathEnabled: true,
          dateConstraintsEnabled: false,
          alwaysShowPatterns: false,
        },
      },
    );
    const floats = scheduleOrThrow(plan).floats;
    expect(floats?.get('dev')?.isCritical).toBe(true);
    expect(floats?.get('test')?.isCritical).toBe(true);
  });

  it('gives exact late dates and floats when a task runs between two blocks kept days apart', () => {
    const spaced = splitTask('dev', [
      [7, 0],
      [7, 3],
    ]);
    const plan = project(
      [spaced, TEST, workTask('side')],
      [blockLink('dev', 'test', { from: 0 }), blockLink('test', 'dev', { to: 1 })],
      {
        options: {
          criticalPathEnabled: true,
          dateConstraintsEnabled: false,
          alwaysShowPatterns: false,
        },
      },
    );
    const floats = scheduleOrThrow(plan).floats;
    expect(floats?.get('dev')).toEqual({
      lateStart: at(2026, 9, 28, 9),
      lateFinish: at(2026, 10, 1, 17),
      totalFloatHours: 0,
      freeFloatHours: 0,
      isCritical: true,
    });
    expect(floats?.get('test')).toEqual({
      lateStart: at(2026, 9, 30, 9),
      lateFinish: at(2026, 9, 30, 17),
      totalFloatHours: 7,
      freeFloatHours: 7,
      isCritical: false,
    });
    expect(floats?.get('side')).toMatchObject({ totalFloatHours: 21, freeFloatHours: 21 });
  });

  it('refuses a loop through the blocks of a task', () => {
    const plan = project(
      [DEVELOPMENT, TEST],
      [blockLink('dev', 'test', { from: 1 }), blockLink('test', 'dev', { to: 0 })],
    );
    const structure = analyzeProjectStructure(plan);
    expect(structure.ok).toBe(false);
    expect(!structure.ok && structure.error.map((error) => error.code)).toEqual([
      'DEPENDENCY_CYCLE',
      'DEPENDENCY_CYCLE',
    ]);
  });

  it.each<[string, Project]>([
    [
      'a block past the last one',
      project([DEVELOPMENT, TEST], [blockLink('dev', 'test', { from: 2 })]),
    ],
    [
      'a block of a milestone',
      project([milestone('m'), TEST], [blockLink('m', 'test', { from: 0 })]),
    ],
    [
      'a block of a task in one block',
      project([TEST, workTask('other')], [blockLink('test', 'other', { from: 0 })]),
    ],
  ])('refuses %s', (_label, plan) => {
    const structure = analyzeProjectStructure(plan);
    expect(!structure.ok && structure.error.map((error) => error.code)).toEqual(['UNKNOWN_BLOCK']);
  });

  it('accepts one link per pair of blocks, and refuses the same pair twice', () => {
    const twice = project(
      [DEVELOPMENT, TEST],
      [blockLink('dev', 'test', { from: 0 }), blockLink('dev', 'test', { from: 1 })],
    );
    expect(analyzeProjectStructure(twice).ok).toBe(true);
    const repeated = project(
      [DEVELOPMENT, TEST],
      [
        blockLink('dev', 'test', { from: 0 }),
        { ...blockLink('dev', 'test', { from: 0 }), id: 'again' },
      ],
    );
    const structure = analyzeProjectStructure(repeated);
    expect(!structure.ok && structure.error.map((error) => error.code)).toEqual([
      'DUPLICATE_DEPENDENCY',
    ]);
  });

  it('resumes a block with no gap right after the previous one', () => {
    expect(resumeAfter({ start: at(2026, 9, 28, 9), end: at(2026, 9, 28, 11) }, 0)).toBe(
      at(2026, 9, 28, 11),
    );
    const plan = project([
      splitTask('dev', [
        [2, 0],
        [3, 0],
      ]),
    ]);
    expect(blocksOf(scheduleOrThrow(plan), 'dev')).toEqual([
      { start: at(2026, 9, 28, 9), end: at(2026, 9, 28, 11) },
      { start: at(2026, 9, 28, 11), end: at(2026, 9, 28, 15) },
    ]);
  });
});

const TYPES: DependencyType[] = [
  'finishToStart',
  'startToStart',
  'finishToFinish',
  'startToFinish',
];

/** Adds random links to and from the blocks of the split tasks of a generated project. */
function withBlockLinks(
  input: Project,
  picks: readonly (readonly [number, number, number, number, number])[],
): Project {
  const split = input.tasks.filter((task) => task.kind === 'task' && task.segments.length > 1);
  const dated = input.tasks.filter((task) => task.kind !== 'summary');
  const extra: Dependency[] = picks.flatMap<Dependency>(
    ([fromPick, toPick, blockPick, typePick, direction], index) => {
      const blockTask = split[fromPick % Math.max(split.length, 1)];
      const other = dated[toPick % Math.max(dated.length, 1)];
      if (blockTask?.kind !== 'task' || other === undefined || other.id === blockTask.id) {
        return [];
      }
      const block = blockPick % blockTask.segments.length;
      const type = TYPES[typePick % TYPES.length] ?? 'finishToStart';
      const base = { id: `block-link-${String(index)}`, type, lagHours: 0 };
      return direction % 2 === 0
        ? [
            {
              ...base,
              predecessorId: blockTask.id,
              successorId: other.id,
              predecessorBlock: block,
              successorBlock: null,
            },
          ]
        : [
            {
              ...base,
              predecessorId: other.id,
              successorId: blockTask.id,
              predecessorBlock: null,
              successorBlock: block,
            },
          ];
    },
  );
  return { ...input, dependencies: [...input.dependencies, ...extra] };
}

describe('scheduling properties with block links', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('respects every link at the level of blocks and keeps the order and gaps of blocks', () => {
    const picks = fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat(), fc.nat()), {
      maxLength: 6,
    });
    fc.assert(
      fc.property(projectArbitrary, picks, (generated, chosen) => {
        const input = withBlockLinks(generated.project, chosen);
        const result = scheduleProject(input);
        fc.pre(result.ok);
        const calendar = unwrap(compileCalendar(input.calendar));
        const spanOf = (id: string, block: number | null, side: 'start' | 'end') => {
          const placement = result.value.placements.get(id);
          const blocks = placement?.segments ?? [];
          const chosenBlock =
            block === null ? (side === 'start' ? blocks[0] : blocks.at(-1)) : blocks[block];
          return chosenBlock ?? placement;
        };
        for (const dependency of input.dependencies) {
          const fromStart =
            dependency.type === 'startToStart' || dependency.type === 'startToFinish';
          const predecessor = spanOf(
            dependency.predecessorId,
            dependency.predecessorBlock,
            fromStart ? 'start' : 'end',
          );
          const toStart = constrainsSuccessorStart(dependency);
          const successor = spanOf(
            dependency.successorId,
            dependency.successorBlock,
            toStart ? 'start' : 'end',
          );
          if (predecessor === undefined || successor === undefined) {
            throw new Error('Missing placement');
          }
          const bound = unwrap(
            shiftWorkingHours(
              calendar,
              dependencyAnchor(dependency, predecessor),
              dependency.lagHours,
            ),
          );
          if (toStart) {
            expect(successor.start).toBeGreaterThanOrEqual(bound);
          } else {
            expect(successor.end).toBeGreaterThanOrEqual(
              unwrap(lastWorkingHourEnd(calendar, bound)),
            );
          }
        }
        for (const task of input.tasks) {
          if (task.kind !== 'task') {
            continue;
          }
          const blocks = result.value.placements.get(task.id)?.segments ?? [];
          blocks.slice(1).forEach((block, index) => {
            const previous = blocks[index];
            if (previous !== undefined) {
              expect(block.start).toBeGreaterThanOrEqual(
                resumeAfter(previous, task.segments[index + 1]?.gapDaysBefore ?? 0),
              );
            }
          });
        }
      }),
    );
  });
});
