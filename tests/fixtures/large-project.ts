import type { Dependency, DependencyType, Project, Tag, Task } from '../../src/core/model/project';
import { milestone, project, splitTask, workTask } from '../../src/core/testing/project-builder';
import { createRandom } from './random';

const TASK_COUNT = 10_000;
const DEPENDENCY_COUNT = 20_000;
const MAX_LINK_DISTANCE = 50;
const MAX_DURATION_HOURS = 40;
const MILESTONE_RATIO = 0.1;
const SPLIT_TASK_RATIO = 0.05;
export const LARGE_PROJECT_SEED = 20_260_928;
const MAX_ATTEMPTS_PER_DEPENDENCY = 10;
const PERSON_COUNT = 20;
const PERSON_TAGS: Tag[] = Array.from({ length: PERSON_COUNT }, (_value, index) => ({
  id: `person${String(index)}`,
  name: `Person ${String(index)}`,
  color: '#2a78d6',
  representsPersonOrTeam: true,
}));
const LINK_TYPES: DependencyType[] = [
  'finishToStart',
  'finishToStart',
  'startToStart',
  'finishToFinish',
];

/** Builds a realistic large project from a seed: short tasks, some milestones and split tasks, local links, 20 people. */
export function buildLargeProject(seed = LARGE_PROJECT_SEED): Project {
  const random = createRandom(seed);
  const idOf = (index: number): string => `t${String(index)}`;
  const tagOf = (index: number): string => `person${String(index % PERSON_COUNT)}`;
  const tasks: Task[] = Array.from({ length: TASK_COUNT }, (_value, index) => {
    const roll = random();
    const durationHours = 1 + Math.floor(random() * MAX_DURATION_HOURS);
    if (roll < MILESTONE_RATIO) {
      return milestone(idOf(index), { tagId: tagOf(index) });
    }
    if (roll < MILESTONE_RATIO + SPLIT_TASK_RATIO) {
      return splitTask(
        idOf(index),
        [
          [durationHours, 0],
          [durationHours, 7],
        ],
        { tagId: tagOf(index) },
      );
    }
    return workTask(idOf(index), {
      segments: [{ durationHours, gapDaysBefore: 0 }],
      tagId: tagOf(index),
    });
  });
  const dependencies = new Map<string, Dependency>();
  for (let attempt = 0; dependencies.size < DEPENDENCY_COUNT; attempt += 1) {
    if (attempt > DEPENDENCY_COUNT * MAX_ATTEMPTS_PER_DEPENDENCY) {
      throw new Error('The random generator produced too few distinct dependencies');
    }
    const from = Math.floor(random() * (TASK_COUNT - 1));
    const to = Math.min(TASK_COUNT - 1, from + 1 + Math.floor(random() * MAX_LINK_DISTANCE));
    const id = `${idOf(from)}->${idOf(to)}`;
    const type = LINK_TYPES[Math.floor(random() * LINK_TYPES.length)] ?? 'finishToStart';
    dependencies.set(id, {
      id,
      predecessorId: idOf(from),
      successorId: idOf(to),
      type,
      lagHours: 0,
    });
  }
  return project(tasks, [...dependencies.values()], { tags: PERSON_TAGS });
}
