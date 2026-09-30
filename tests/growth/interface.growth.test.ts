import { describe, expect, it } from 'vitest';
import { buildPlanOutline, groupIncoming } from '../../src/renderer/plan/plan-outline';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SMALL_TASK_COUNT,
} from './measure-growth';

describe('growth of what the interface prepares after a change', () => {
  const small = buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT);
  const large = buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT);

  it('orders, numbers and links the rows in quasi-linear time', () => {
    const prepare = (project: typeof small) => () => {
      buildPlanOutline(project.tasks, new Set());
      groupIncoming(project.dependencies);
    };
    const ratio = growthRatio(prepare(small), prepare(large));
    console.info(`Interface rows: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
