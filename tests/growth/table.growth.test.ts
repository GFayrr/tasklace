import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/core/model/project';
import { compileOrThrow } from '../../src/core/testing/civil-time';
import { scheduleOrThrow } from '../../src/core/testing/project-builder';
import english from '../../src/renderer/locales/en.json';
import {
  buildPlanOutline,
  groupIncoming,
  predecessorText,
} from '../../src/renderer/plan/plan-outline';
import { createTableFormatters, floatCells, taskCells } from '../../src/renderer/plan/table-format';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  CONSTANT_MAX_RATIO,
  growthRatio,
  LARGE_TASK_COUNT,
  SMALL_TASK_COUNT,
} from './measure-growth';

const VISIBLE_ROWS = 40;
const MIDDLE = 0.5;

describe('growth of the table', () => {
  const small = buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT);
  const large = buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT);

  /** Prepares the project once, then returns how to write the cells of the rows shown in the middle of the table, as the table does after each change. */
  const visibleCells = (project: Project) => {
    const withFloats = { ...project, options: { ...project.options, criticalPathEnabled: true } };
    const schedule = scheduleOrThrow(withFloats);
    const calendar = compileOrThrow(project.calendar);
    const outline = buildPlanOutline(project.tasks, new Set());
    const incoming = groupIncoming(project.dependencies);
    const formatters = createTableFormatters('en-US');
    const first = Math.floor(outline.rows.length * MIDDLE);
    const shown = outline.rows.slice(first, first + VISIBLE_ROWS);
    return () => {
      for (const row of shown) {
        taskCells(row.task, schedule, calendar, formatters, english);
        floatCells(schedule.floats?.get(row.task.id), formatters, english);
        predecessorText(incoming.get(row.task.id), outline.wbsById);
      }
    };
  };

  it('writes the cells of the rows shown in a time that does not depend on the size of the project', () => {
    const ratio = growthRatio(visibleCells(small), visibleCells(large));
    console.info(`Visible cells: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(CONSTANT_MAX_RATIO);
  });
});
