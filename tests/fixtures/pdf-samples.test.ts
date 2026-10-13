import { describe, expect, it } from 'vitest';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { readSharedProject } from '../../src/core/shared/shared-project';
import { scheduleOrThrow, TEST_DOCUMENT_ID } from '../../src/core/testing/project-builder';
import { buildPdfSample, PDF_SAMPLE_SIZES } from './pdf-samples';

const HOURS_PER_DAY = 24;

/** Sorts items by their identifier, the order a shared document gives them back in being its own. */
function byId<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

describe('the sample plans of the PDF export', () => {
  it.each([
    ['small', 'Small plan', 12, 10, 28, 1, 2],
    ['medium', 'Medium plan', 108, 116, 184, 6, 6],
    ['large', 'Large plan', 504, 568, 800, 52, 12],
  ] as const)(
    'builds the %s plan, schedulable, with its tasks, links, span in days, split tasks and phases',
    (size, name, taskCount, linkCount, days, splitCount, phaseCount) => {
      const plan = buildPdfSample(size);
      const schedule = scheduleOrThrow(plan);
      const placements = [...schedule.placements.values()];
      const first = Math.min(...placements.map((placement) => placement.start));
      const last = Math.max(...placements.map((placement) => placement.end));
      expect([plan.name, plan.tasks.length, plan.dependencies.length]).toEqual([
        name,
        taskCount,
        linkCount,
      ]);
      expect(Math.round((last - first) / HOURS_PER_DAY)).toBe(days);
      expect(plan.options.criticalPathEnabled).toBe(true);
      expect(
        plan.tasks.filter((task) => task.kind === 'task' && task.segments.length > 1),
      ).toHaveLength(splitCount);
      expect(plan.tasks.filter((task) => task.kind === 'milestone')).toHaveLength(phaseCount);
      expect(plan.tasks.filter((task) => task.kind === 'summary')).toHaveLength(phaseCount);
    },
  );

  it.each(PDF_SAMPLE_SIZES)('builds the %s plan as a project that a file may hold', (size) => {
    const plan = buildPdfSample(size);
    const read = readSharedProject(createSharedDocument(plan, TEST_DOCUMENT_ID));
    if (!read.ok) {
      throw new Error(JSON.stringify(read.error));
    }
    expect(byId(read.value.tasks)).toEqual(byId(plan.tasks));
    expect(byId(read.value.dependencies)).toEqual(byId(plan.dependencies));
  });

  it('builds the same plan from the same seed and another one from another seed', () => {
    expect(buildPdfSample('medium')).toEqual(buildPdfSample('medium'));
    expect(buildPdfSample('medium', 1)).not.toEqual(buildPdfSample('medium'));
  });
});
