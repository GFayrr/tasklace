/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/core/model/project';
import { compileOrThrow } from '../../src/core/testing/civil-time';
import { scheduleOrThrow } from '../../src/core/testing/project-builder';
import { conflictLines } from '../../src/renderer/plan/conflict-lines';
import { buildPlanOutline, groupIncoming } from '../../src/renderer/plan/plan-outline';
import { tagStylesOf } from '../../src/renderer/plan/tag-styles';
import { recordingCanvas } from '../../src/renderer/plan/testing/recording-canvas';
import { pixelsPerHour } from '../../src/renderer/plan/time-scale';
import { timelineFrame } from '../../src/renderer/plan/timeline-geometry';
import {
  paintTimelineBody,
  type TimelineScene,
  type Viewport,
} from '../../src/renderer/plan/timeline-painter';
import { SAND_GRAPHITE } from '../../src/renderer/theme/sand-graphite';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SMALL_TASK_COUNT,
} from './measure-growth';

const WINDOW_WIDTH = 1_200;
const WINDOW_HEIGHT = 800;

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

describe('growth of the list of conflicts', () => {
  it('describes the conflicts of a project in linear time', () => {
    const asPeople = (project: Project): Project => ({
      ...project,
      tags: project.tags.map((tag) => ({ ...tag, representsPersonOrTeam: true })),
    });
    const small = asPeople(buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT));
    const large = asPeople(buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT));
    const smallSchedule = scheduleOrThrow(small);
    const largeSchedule = scheduleOrThrow(large);
    expect(largeSchedule.tagConflicts.conflicts.length).toBeGreaterThan(
      smallSchedule.tagConflicts.conflicts.length,
    );
    const ratio = growthRatio(
      () => conflictLines(smallSchedule, small),
      () => conflictLines(largeSchedule, large),
    );
    console.info(`Conflict lines: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});

describe('growth of drawing the timeline', () => {
  /** Builds the scene of a large project, shown from its start in a window of fixed size. */
  function sceneOf(project: Project): { scene: TimelineScene; viewport: Viewport } {
    const schedule = scheduleOrThrow(project);
    const outline = buildPlanOutline(project.tasks, new Set());
    const frame = timelineFrame(
      project.startDate,
      schedule,
      project.startDate,
      pixelsPerHour('day'),
    );
    const scene: TimelineScene = {
      frame,
      zoom: 'day',
      rows: outline.rows,
      rowIndexById: outline.rowIndexById,
      schedule,
      dependencies: project.dependencies,
      calendar: compileOrThrow(project.calendar),
      nonWorkingPeriods: [],
      theme: SAND_GRAPHITE,
      tagStyles: tagStylesOf(project),
      conflictTaskIds: new Set(),
      selectedTaskId: null,
      today: project.startDate,
      preview: null,
      patternFor: () => null,
    };
    return { scene, viewport: { left: 0, top: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT } };
  }

  it('draws one frame, links included, in at most linear time of the project', () => {
    const small = sceneOf(buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT));
    const large = sceneOf(buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT));
    const draw =
      ({ scene, viewport }: ReturnType<typeof sceneOf>) =>
      () => {
        paintTimelineBody(recordingCanvas().context, scene, viewport);
      };
    const ratio = growthRatio(draw(small), draw(large));
    console.info(`Timeline frame: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('draws one frame with the critical path and the floats in at most linear time of the project', () => {
    const withCriticalPath = (project: Project): Project => ({
      ...project,
      options: { ...project.options, criticalPathEnabled: true },
    });
    const small = sceneOf(
      withCriticalPath(buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT)),
    );
    const large = sceneOf(
      withCriticalPath(buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT)),
    );
    expect(large.scene.schedule?.floats?.size).toBe(LARGE_TASK_COUNT);
    const draw =
      ({ scene, viewport }: ReturnType<typeof sceneOf>) =>
      () => {
        paintTimelineBody(recordingCanvas().context, scene, viewport);
      };
    const ratio = growthRatio(draw(small), draw(large));
    console.info(`Timeline frame with floats: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
