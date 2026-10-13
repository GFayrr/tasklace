import type { Dependency, Project, Tag, Task } from '../../src/core/model/project';
import {
  link,
  milestone,
  project,
  splitTask,
  summary,
  workTask,
} from '../../src/core/testing/project-builder';
import { createRandom } from './random';

export type PdfSampleSize = 'small' | 'medium' | 'large';

export const PDF_SAMPLE_SIZES: readonly PdfSampleSize[] = ['small', 'medium', 'large'];

export const PDF_SAMPLES_SEED = 20_261_013;

interface SampleShape {
  readonly name: string;
  readonly phases: number;
  readonly chainsPerPhase: number;
  readonly tasksPerChain: number;
  readonly workingHours: number;
}

const WORKING_HOURS_PER_MONTH = 140;
const MONTHS_PER_YEAR = 12;
const SHAPES: Readonly<Record<PdfSampleSize, SampleShape>> = {
  small: {
    name: 'Small plan',
    phases: 2,
    chainsPerPhase: 2,
    tasksPerChain: 2,
    workingHours: WORKING_HOURS_PER_MONTH,
  },
  medium: {
    name: 'Medium plan',
    phases: 6,
    chainsPerPhase: 4,
    tasksPerChain: 4,
    workingHours: WORKING_HOURS_PER_MONTH * 6,
  },
  large: {
    name: 'Large plan',
    phases: 12,
    chainsPerPhase: 8,
    tasksPerChain: 5,
    workingHours: WORKING_HOURS_PER_MONTH * MONTHS_PER_YEAR * 2,
  },
};
const TAGS: readonly Tag[] = [
  { id: 'design', name: 'Design', color: '#2a78d6', representsPersonOrTeam: false },
  { id: 'documentation', name: 'Documentation', color: '#2a78d7', representsPersonOrTeam: false },
  { id: 'development', name: 'Development', color: '#1baf7a', representsPersonOrTeam: false },
  { id: 'testing', name: 'Testing', color: '#eb6834', representsPersonOrTeam: false },
  { id: 'deployment', name: 'Deployment', color: '#4a3aa7', representsPersonOrTeam: false },
];
const SPLIT_EVERY = 9;
const SPREAD = 0.5;
const SECOND_BLOCK_SHARE = 0.4;
const MAX_GAP_DAYS = 3;
const MAX_PROGRESS = 101;
const NAMES = ['Research', 'Design', 'Build', 'Review', 'Test', 'Write', 'Plan', 'Deliver'];

interface Building {
  readonly shape: SampleShape;
  readonly random: () => number;
  readonly meanHours: number;
  readonly tasks: Task[];
  readonly links: Dependency[];
}

/** Builds a sample plan for the PDF export from a fixed seed: about 10 tasks over a month, 100 over six months or 500 over two years, in phases of parallel chains, with split tasks, milestones, links, tags and the critical path. */
export function buildPdfSample(size: PdfSampleSize, seed = PDF_SAMPLES_SEED): Project {
  const shape = SHAPES[size];
  const building: Building = {
    shape,
    random: createRandom(seed),
    meanHours: shape.workingHours / (shape.phases * shape.tasksPerChain),
    tasks: [],
    links: [],
  };
  let previousMilestone: string | null = null;
  for (let phase = 0; phase < shape.phases; phase += 1) {
    previousMilestone = addPhase(building, phase, previousMilestone);
  }
  const base = project(building.tasks, building.links, { tags: [...TAGS] });
  return { ...base, name: shape.name, options: { ...base.options, criticalPathEnabled: true } };
}

/** Adds a phase: a summary holding parallel chains that wait for the milestone of the phase before, and a milestone that waits for every chain, returning that milestone. */
function addPhase(building: Building, phase: number, previousMilestone: string | null): string {
  const { shape, tasks, links } = building;
  const phaseId = `p${String(phase)}`;
  tasks.push(
    summary(phaseId, { name: `Phase ${String(phase + 1)}`, sortKey: sortKeyOf(phase, 0) }),
  );
  const lastOfChains = Array.from({ length: shape.chainsPerPhase }, (_unused, chain) =>
    addChain(building, phase, chain, previousMilestone),
  );
  const milestoneId = `${phaseId}m`;
  tasks.push(
    milestone(milestoneId, {
      parentId: phaseId,
      name: `End of phase ${String(phase + 1)}`,
      sortKey: sortKeyOf(phase, 1 + shape.chainsPerPhase * shape.tasksPerChain),
    }),
  );
  links.push(...lastOfChains.map((last) => link(last, milestoneId)));
  return milestoneId;
}

/** Adds a chain of tasks one after the other, the first waiting for the given task when there is one, returning the last task. */
function addChain(building: Building, phase: number, chain: number, first: string | null): string {
  let previous = first;
  for (let step = 0; step < building.shape.tasksPerChain; step += 1) {
    const id = addTask(building, phase, chain, step);
    if (previous !== null) {
      building.links.push(link(previous, id));
    }
    previous = id;
  }
  return previous ?? '';
}

/** Adds one task of a chain, split in two blocks now and then, with a random length around the mean, a tag and progress, returning its identifier. */
function addTask(building: Building, phase: number, chain: number, step: number): string {
  const { shape, random, tasks } = building;
  const id = `p${String(phase)}c${String(chain)}t${String(step)}`;
  const index = tasks.length;
  const hours = Math.max(1, Math.round(building.meanHours * (1 - SPREAD + random() * SPREAD * 2)));
  const fields = {
    parentId: `p${String(phase)}`,
    sortKey: sortKeyOf(phase, 1 + chain * shape.tasksPerChain + step),
    name: `${NAMES[(chain + step) % NAMES.length] ?? 'Task'} ${String(index)}`,
    tagId: TAGS[(chain + phase) % TAGS.length]?.id ?? null,
    progressPercent: Math.floor(random() * MAX_PROGRESS),
  };
  if (index % SPLIT_EVERY !== 0) {
    tasks.push(
      workTask(id, {
        ...fields,
        segments: [{ durationHours: hours, gapDaysBefore: 0, startNoEarlierThan: null }],
      }),
    );
    return id;
  }
  const first = Math.max(1, Math.round(hours * (1 - SECOND_BLOCK_SHARE)));
  const second = Math.max(1, Math.round(hours * SECOND_BLOCK_SHARE));
  tasks.push(
    splitTask(
      id,
      [
        [first, 0],
        [second, 1 + Math.floor(random() * MAX_GAP_DAYS)],
      ],
      fields,
    ),
  );
  return id;
}

/** Returns the sort key of a row of a phase, so that phases and their rows keep their order. */
function sortKeyOf(phase: number, row: number): string {
  return `${String(phase).padStart(3, '0')}${String(row).padStart(4, '0')}`;
}
