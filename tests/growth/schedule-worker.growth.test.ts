import { describe, expect, it } from 'vitest';
import { answerScheduleRequest } from '../../src/renderer/schedule/schedule-protocol';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SMALL_TASK_COUNT,
} from './measure-growth';

describe('growth of the schedule worker round trip', () => {
  const small = buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT);
  const large = buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT);

  /** Sends a project to the worker and back, copying both messages as the browser does. */
  const roundTrip = (project: typeof small) => () => {
    const request = structuredClone({ version: 1, generation: 1, project });
    const response = structuredClone(answerScheduleRequest(request));
    expect(response?.result.ok).toBe(true);
  };

  it('copies, schedules and copies back a project in linear time', () => {
    const ratio = growthRatio(roundTrip(small), roundTrip(large));
    console.info(`Schedule worker round trip: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
