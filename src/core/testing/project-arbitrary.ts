import fc from 'fast-check';
import { compileCalendar } from '../calendar/compile-calendar';
import type { Dependency, DependencyType, Project, SchedulableTask, Task } from '../model/project';
import { calendarArbitrary, instantArbitrary, unwrap } from './arbitraries';
import { milestone, project, summary, workTask } from './project-builder';

const MAX_TASKS = 20;
const MAX_BLOCK_HOURS = 30;
const MAX_GAP_DAYS = 10;
const MAX_LAG = 20;
const FULL_PROGRESS = 100;
const HALF_PROGRESS = 50;
const DEPENDENCY_TYPES: DependencyType[] = [
  'finishToStart',
  'startToStart',
  'finishToFinish',
  'startToFinish',
];

export interface GeneratedProject {
  readonly project: Project;
}

const blockArbitrary = fc.record({
  durationHours: fc.integer({ min: 1, max: MAX_BLOCK_HOURS }),
  gapDaysBefore: fc.integer({ min: 1, max: MAX_GAP_DAYS }),
});

const taskShapeArbitrary = fc.record({
  isMilestone: fc.boolean(),
  blocks: fc.array(blockArbitrary, { minLength: 1, maxLength: 3 }),
  hoursPerDayRatio: fc.option(fc.double({ min: 0, max: 1, noNaN: true })),
  startNoEarlierThan: fc.option(instantArbitrary),
  progressPercent: fc.integer({ min: 0, max: 100 }),
  parentIndex: fc.option(fc.integer({ min: 0, max: 2 })),
});

const dependencyShapeArbitrary = fc.record({
  from: fc.nat(),
  to: fc.nat(),
  type: fc.constantFrom(...DEPENDENCY_TYPES),
  lagHours: fc.integer({ min: -MAX_LAG, max: MAX_LAG }),
});

type TaskShape = typeof taskShapeArbitrary extends fc.Arbitrary<infer Shape> ? Shape : never;
type DependencyShape =
  typeof dependencyShapeArbitrary extends fc.Arbitrary<infer Shape> ? Shape : never;

/** Builds a work task or a milestone from a random shape, keeping hours per day within the calendar and milestones either not started or done. */
function buildTask(index: number, shape: TaskShape, hoursPerWorkingDay: number): SchedulableTask {
  const id = `t${String(index).padStart(2, '0')}`;
  const common = {
    parentId: shape.parentIndex === null ? null : `s${String(shape.parentIndex)}`,
    progressPercent: shape.progressPercent,
    startNoEarlierThan: shape.startNoEarlierThan,
  };
  if (shape.isMilestone) {
    const progressPercent = shape.progressPercent < HALF_PROGRESS ? 0 : FULL_PROGRESS;
    return milestone(id, { ...common, progressPercent });
  }
  const segments = shape.blocks.map((block, blockIndex) => ({
    durationHours: block.durationHours,
    gapDaysBefore: blockIndex === 0 ? 0 : block.gapDaysBefore,
  }));
  const hoursPerDay =
    shape.hoursPerDayRatio === null
      ? null
      : Math.max(1, Math.round(shape.hoursPerDayRatio * hoursPerWorkingDay));
  return workTask(id, { ...common, segments, hoursPerDay });
}

/** Turns random link shapes into forward links between distinct tasks, one per pair, so that the network is acyclic. */
function buildDependencies(taskCount: number, shapes: readonly DependencyShape[]): Dependency[] {
  const byPair = new Map<string, Dependency>();
  for (const shape of shapes) {
    const from = shape.from % taskCount;
    const to = shape.to % taskCount;
    if (from < to) {
      const predecessorId = `t${String(from).padStart(2, '0')}`;
      const successorId = `t${String(to).padStart(2, '0')}`;
      const id = `${predecessorId}-${successorId}`;
      byPair.set(id, {
        id,
        predecessorId,
        successorId,
        type: shape.type,
        lagHours: shape.lagHours,
      });
    }
  }
  return [...byPair.values()];
}

export const projectArbitrary: fc.Arbitrary<GeneratedProject> = calendarArbitrary.chain(
  (calendarInput) => {
    const calendar = unwrap(compileCalendar(calendarInput));
    return fc
      .record({
        startDate: instantArbitrary,
        taskShapes: fc.array(taskShapeArbitrary, { minLength: 1, maxLength: MAX_TASKS }),
        dependencyShapes: fc.array(dependencyShapeArbitrary, { maxLength: MAX_TASKS * 2 }),
      })
      .map(({ startDate, taskShapes, dependencyShapes }) => {
        const hoursPerWorkingDay = calendar.workingHoursOfDay.length;
        const leaves = taskShapes.map((shape, index) =>
          buildTask(index, shape, hoursPerWorkingDay),
        );
        const summaries: Task[] = [summary('s0'), summary('s1', { parentId: 's0' }), summary('s2')];
        const dependencies = buildDependencies(leaves.length, dependencyShapes);
        return {
          project: project([...summaries, ...leaves], dependencies, {
            startDate,
            calendar: calendarInput,
            options: {
              criticalPathEnabled: true,
              dateConstraintsEnabled: false,
              alwaysShowPatterns: false,
            },
          }),
        };
      });
  },
);
