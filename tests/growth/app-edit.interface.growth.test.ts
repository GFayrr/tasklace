import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/core/model/project';
import { openedAppOf, settle } from '../../src/renderer/app/testing/fake-app-context';
import { renameTask } from '../../src/renderer/plan/task-commands';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  growthRatioOf,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SMALL_TASK_COUNT,
} from './measure-growth';

/** Opens a project in the interface state with a scheduler that only records its requests, so that only what the page does after an edit is measured. */
async function editorOf(project: Project) {
  const opened = await openedAppOf(project);
  opened.scheduler.automatic = false;
  const tasks = opened.app.project?.tasks ?? [];
  /** Renames a task as the table does, then waits for the interface to read the project again and builds the rows it shows. */
  return async (index: number): Promise<void> => {
    const task = tasks[index % tasks.length];
    if (task === undefined) {
      throw new Error('The project has no task.');
    }
    const refusal = opened.app.tryEdit((context) =>
      renameTask(context, task.id, `Renamed ${String(index)}`),
    );
    if (refusal !== null) {
      throw new Error(refusal);
    }
    await settle();
    expect(opened.app.outline.rows).toHaveLength(tasks.length);
  };
}

describe('growth of an edit seen from the interface', () => {
  it('renames a task and shows the project again in linear time', async () => {
    const small = await editorOf(buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT));
    const large = await editorOf(buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT));
    const ratio = await growthRatioOf(small, large);
    console.info(`Edit seen from the interface: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
