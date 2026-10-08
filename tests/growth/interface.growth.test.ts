/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/core/model/project';
import { compileOrThrow } from '../../src/core/testing/civil-time';
import { scheduleOrThrow } from '../../src/core/testing/project-builder';
import { conflictLines, dateConflictLines } from '../../src/renderer/plan/conflict-lines';
import { loadMessages } from '../../src/renderer/i18n/messages';
import { dateConflictTitles } from '../../src/renderer/plan/table-format';
import { buildPlanOutline, groupIncoming } from '../../src/renderer/plan/plan-outline';
import { tagStylesOf } from '../../src/renderer/plan/tag-styles';
import { recordingCanvas } from '../../src/renderer/plan/testing/recording-canvas';
import { pixelsPerHour } from '../../src/renderer/plan/time-scale';
import { deadlinesOf, timelineFrame } from '../../src/renderer/plan/timeline-geometry';
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
    /** Prepares the rows and the links of a project as the interface does after a change. */
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
    /** Makes every tag of a project a person or team. */
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

describe('growth of the dates tasks do not meet', () => {
  it('describes the missed deadlines, their tooltips and the deadlines shown in linear time', async () => {
    const messages = await loadMessages('en');
    /** Gives every task of a project a deadline at the project start, the date constraints turned on. */
    const late = (project: Project): Project => ({
      ...project,
      options: { ...project.options, dateConstraintsEnabled: true },
      tasks: project.tasks.map((task) =>
        task.kind === 'summary' ? task : { ...task, deadline: project.startDate },
      ),
    });
    const small = late(buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT));
    const large = late(buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT));
    const smallSchedule = scheduleOrThrow(small);
    const largeSchedule = scheduleOrThrow(large);
    /** Counts the tasks that end after the project start. */
    const lateTasks = (project: Project, schedule: typeof smallSchedule) =>
      [...schedule.placements.values()].filter((placement) => placement.end > project.startDate)
        .length;
    expect(smallSchedule.conflicts).toHaveLength(lateTasks(small, smallSchedule));
    expect(largeSchedule.conflicts).toHaveLength(lateTasks(large, largeSchedule));
    /** Describes the dates the tasks miss and lists the deadlines shown. */
    const describeDates = (project: Project, schedule: typeof smallSchedule) => () => {
      dateConflictTitles(dateConflictLines(schedule, project), messages, String);
      deadlinesOf(project);
    };
    const ratio = growthRatio(
      describeDates(small, smallSchedule),
      describeDates(large, largeSchedule),
    );
    console.info(`Date conflict lines: ×${ratio.toFixed(2)}`);
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
      [],
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
      deadlines: null,
      baseline: null,
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
    /** Draws one frame of a scene. */
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
    /** Turns the critical path on in a project. */
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
    /** Draws one frame of a scene. */
    const draw =
      ({ scene, viewport }: ReturnType<typeof sceneOf>) =>
      () => {
        paintTimelineBody(recordingCanvas().context, scene, viewport);
      };
    const ratio = growthRatio(draw(small), draw(large));
    console.info(`Timeline frame with floats: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('draws one frame with a baseline entry for every task in at most linear time of the project', () => {
    /** Adds a baseline entry for every row of a scene. */
    const withBaseline = ({ scene, viewport }: ReturnType<typeof sceneOf>) => {
      const entries = new Map(
        scene.rows.map((row) => {
          const start = scene.frame.origin + 24 * 8;
          return [row.task.id, { taskId: row.task.id, start, end: start + 9, durationHours: 9 }];
        }),
      );
      return { scene: { ...scene, baseline: entries }, viewport };
    };
    const small = withBaseline(sceneOf(buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT)));
    const large = withBaseline(sceneOf(buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT)));
    /** Draws one frame of a scene. */
    const draw =
      ({ scene, viewport }: ReturnType<typeof sceneOf>) =>
      () => {
        paintTimelineBody(recordingCanvas().context, scene, viewport);
      };
    const ratio = growthRatio(draw(small), draw(large));
    console.info(`Timeline frame with a baseline: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('draws one frame with a deadline on every task in at most linear time of the project', () => {
    /** Adds a deadline to every task of a scene. */
    const withDeadlines = ({ scene, viewport }: ReturnType<typeof sceneOf>) => {
      const ids = scene.rows.map((row) => row.task.id);
      const rows = scene.rows.map((row) =>
        row.task.kind === 'summary'
          ? row
          : { ...row, task: { ...row.task, deadline: scene.frame.origin + 24 * 10 } },
      );
      const missedTaskIds = new Set(ids.filter((_id, index) => index % 2 === 0));
      return { scene: { ...scene, rows, deadlines: { missedTaskIds } }, viewport };
    };
    const small = withDeadlines(sceneOf(buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT)));
    const large = withDeadlines(sceneOf(buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT)));
    /** Draws one frame of a scene. */
    const draw =
      ({ scene, viewport }: ReturnType<typeof sceneOf>) =>
      () => {
        paintTimelineBody(recordingCanvas().context, scene, viewport);
      };
    const ratio = growthRatio(draw(small), draw(large));
    console.info(`Timeline frame with deadlines: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
