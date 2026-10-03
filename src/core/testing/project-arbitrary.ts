import fc from 'fast-check';
import { compileCalendar, type CompiledCalendar } from '../calendar/compile-calendar';
import { MAX_HIERARCHY_DEPTH } from '../limits';
import { TAG_PALETTE } from '../tags/tag-palette';
import type { Dependency, DependencyType, Project, SchedulableTask, Task } from '../model/project';
import { fromQuarters, QUARTER_HOUR, QUARTERS_PER_HOUR, toQuarters } from '../time';
import { calendarArbitrary, instantArbitrary, quarterHoursArbitrary, unwrap } from './arbitraries';
import { analyzeProjectStructure } from '../scheduling/project-structure';
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
  durationHours: quarterHoursArbitrary(QUARTER_HOUR, MAX_BLOCK_HOURS),
  gapDaysBefore: fc.integer({ min: 0, max: MAX_GAP_DAYS }),
  startNoEarlierThan: fc.option(instantArbitrary),
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
  lagHours: quarterHoursArbitrary(-MAX_LAG, MAX_LAG),
  fromBlock: fc.option(fc.nat()),
  toBlock: fc.option(fc.nat()),
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
    startNoEarlierThan: blockIndex === 0 ? null : block.startNoEarlierThan,
  }));
  const hoursPerDay =
    shape.hoursPerDayRatio === null || hoursPerWorkingDay < 1
      ? null
      : fromQuarters(
          Math.max(
            QUARTERS_PER_HOUR,
            Math.round(shape.hoursPerDayRatio * toQuarters(hoursPerWorkingDay)),
          ),
        );
  return workTask(id, { ...common, segments, hoursPerDay });
}

/** Turns random link shapes into forward links between distinct tasks, one per pair, some of them to or from a block of a split task, so that the network is acyclic even block by block. */
function buildDependencies(
  leaves: readonly SchedulableTask[],
  shapes: readonly DependencyShape[],
): Dependency[] {
  const byPair = new Map<string, Dependency>();
  for (const shape of shapes) {
    const from = shape.from % leaves.length;
    const to = shape.to % leaves.length;
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
        predecessorBlock: blockOf(leaves[from], shape.fromBlock),
        successorBlock: blockOf(leaves[to], shape.toBlock),
      });
    }
  }
  return [...byPair.values()];
}

/** Picks a block of a split work task, or the whole task for any other task or no pick. */
function blockOf(task: SchedulableTask | undefined, pick: number | null): number | null {
  if (task?.kind !== 'task' || task.segments.length < 2 || pick === null) {
    return null;
  }
  return pick % task.segments.length;
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
        const hoursPerWorkingDay = calendar.workingHoursPerDay;
        const leaves = taskShapes.map((shape, index) =>
          buildTask(index, shape, hoursPerWorkingDay),
        );
        const summaries: Task[] = [summary('s0'), summary('s1', { parentId: 's0' }), summary('s2')];
        const dependencies = buildDependencies(leaves, dependencyShapes);
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

/** Generates projects where a task runs between two blocks of a split task, waiting for one block and making the next one wait for it, with random types, lags and gaps, keeping only projects without loops. */
export const interleavedProjectArbitrary: fc.Arbitrary<GeneratedProject> = projectArbitrary
  .chain((generated) =>
    fc.record({
      generated: fc.constant(generated),
      splitPick: fc.nat(),
      insidePick: fc.nat(),
      blockPick: fc.nat(),
      leaving: fc.constantFrom(...DEPENDENCY_TYPES),
      entering: fc.constantFrom(...DEPENDENCY_TYPES),
      lags: fc.tuple(
        quarterHoursArbitrary(-MAX_LAG, MAX_LAG),
        quarterHoursArbitrary(-MAX_LAG, MAX_LAG),
      ),
    }),
  )
  .map(({ generated, splitPick, insidePick, blockPick, leaving, entering, lags }) =>
    withTaskBetweenBlocks(generated.project, {
      splitPick,
      insidePick,
      blockPick,
      leaving,
      entering,
      lags,
    }),
  )
  .filter((generated) => analyzeProjectStructure(generated.project).ok);

/** Adds to a project a task running between two consecutive blocks of a split task, or leaves it unchanged when it has no split task or no other task. */
function withTaskBetweenBlocks(
  input: Project,
  picks: {
    readonly splitPick: number;
    readonly insidePick: number;
    readonly blockPick: number;
    readonly leaving: DependencyType;
    readonly entering: DependencyType;
    readonly lags: readonly [number, number];
  },
): GeneratedProject {
  const split = input.tasks.filter((task) => task.kind === 'task' && task.segments.length > 1);
  const splitTask = split[picks.splitPick % Math.max(split.length, 1)];
  const others = input.tasks.filter((task) => task.kind !== 'summary' && task.id !== splitTask?.id);
  const inside = others[picks.insidePick % Math.max(others.length, 1)];
  if (splitTask?.kind !== 'task' || inside === undefined) {
    return { project: input };
  }
  const block = picks.blockPick % (splitTask.segments.length - 1);
  const kept = input.dependencies.filter(
    (link) =>
      ![splitTask.id, inside.id].includes(link.predecessorId) ||
      ![splitTask.id, inside.id].includes(link.successorId),
  );
  const between: Dependency[] = [
    {
      id: `between-out-${splitTask.id}`,
      predecessorId: splitTask.id,
      predecessorBlock: block,
      successorId: inside.id,
      successorBlock: null,
      type: picks.leaving,
      lagHours: picks.lags[0],
    },
    {
      id: `between-in-${splitTask.id}`,
      predecessorId: inside.id,
      predecessorBlock: null,
      successorId: splitTask.id,
      successorBlock: block + 1,
      type: picks.entering,
      lagHours: picks.lags[1],
    },
  ];
  return { project: { ...input, dependencies: [...kept, ...between] } };
}

const MAX_RICH_TAGS = 6;
const MAX_GENERATED_NAME = 20;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Generates names of any script, emoji included, that a project accepts: well formed, without control characters and not blank. */
const nameArbitrary = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: MAX_GENERATED_NAME })
  .filter((text) => text.trim() !== '' && text.isWellFormed() && !CONTROL_CHARACTER.test(text));

const richTaskArbitrary = fc.record({
  name: nameArbitrary,
  tagPick: fc.option(fc.nat()),
  mustFinishOn: fc.option(instantArbitrary),
  deadline: fc.option(instantArbitrary),
  dailyStartPick: fc.option(fc.nat()),
});

/** Picks a daily start time that leaves a work task enough working time each day, or none when the task uses the hours of the project or no pick is given. */
function dailyStartOf(
  task: SchedulableTask,
  calendar: CompiledCalendar,
  pick: number | null,
): number | null {
  if (task.kind !== 'task' || task.hoursPerDay === null || pick === null) {
    return null;
  }
  const starts = calendar.workingQuartersOfDay;
  const choices = starts.length - toQuarters(task.hoursPerDay) + 1;
  return starts[pick % Math.max(choices, 1)] ?? null;
}

/** Generates projects using every feature a file can hold: tags, some of them people or teams, date constraints enabled or not, daily start times, Unicode names and summaries nested up to the deepest allowed level. */
export const richProjectArbitrary: fc.Arbitrary<GeneratedProject> = projectArbitrary.chain(
  ({ project: base }) =>
    fc
      .record({
        projectName: nameArbitrary,
        tags: fc.uniqueArray(
          fc.record({
            name: nameArbitrary,
            color: fc.constantFrom(...TAG_PALETTE),
            person: fc.boolean(),
          }),
          { maxLength: MAX_RICH_TAGS, selector: (tag) => tag.name },
        ),
        tasks: fc.array(richTaskArbitrary, {
          minLength: base.tasks.length,
          maxLength: base.tasks.length,
        }),
        depth: fc.integer({ min: 0, max: MAX_HIERARCHY_DEPTH - 1 }),
        dateConstraintsEnabled: fc.boolean(),
        alwaysShowPatterns: fc.boolean(),
      })
      .map((extra) => {
        const calendar = unwrap(compileCalendar(base.calendar));
        const tags = extra.tags.map((tag, index) => ({
          id: `g${String(index)}`,
          name: tag.name,
          color: tag.color,
          representsPersonOrTeam: tag.person,
        }));
        const chain: Task[] = Array.from({ length: extra.depth }, (_, level) =>
          summary(`d${String(level)}`, { parentId: level === 0 ? null : `d${String(level - 1)}` }),
        );
        const deepest = chain.at(-1)?.id ?? null;
        const tasks = base.tasks.map((task, index): Task => {
          const shape = extra.tasks[index];
          if (shape === undefined || task.kind === 'summary') {
            return { ...task, name: shape?.name ?? task.name };
          }
          const tagId =
            shape.tagPick === null || tags.length === 0
              ? null
              : (tags[shape.tagPick % tags.length]?.id ?? null);
          const moved = deepest !== null && task.id === 't00' ? { parentId: deepest } : {};
          const constraints = { mustFinishOn: shape.mustFinishOn, deadline: shape.deadline };
          if (task.kind === 'milestone') {
            return { ...task, ...moved, name: shape.name, tagId, ...constraints };
          }
          return {
            ...task,
            ...moved,
            name: shape.name,
            tagId,
            ...constraints,
            dailyStartHour: dailyStartOf(task, calendar, shape.dailyStartPick),
          };
        });
        return {
          project: {
            ...base,
            name: extra.projectName,
            tags,
            tasks: [...chain, ...tasks],
            options: {
              criticalPathEnabled: true,
              dateConstraintsEnabled: extra.dateConstraintsEnabled,
              alwaysShowPatterns: extra.alwaysShowPatterns,
            },
          },
        };
      }),
);
