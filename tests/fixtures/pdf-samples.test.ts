import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { readSharedProject } from '../../src/core/shared/shared-project';
import { scheduleOrThrow, TEST_DOCUMENT_ID } from '../../src/core/testing/project-builder';
import { buildPdfSample, PDF_SAMPLE_SIZES } from './pdf-samples';

const HOURS_PER_DAY = 24;

/** Returns the SHA-256 fingerprint of a value serialized as JSON. */
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Sorts items by their identifier, since a shared document gives them back in an order of its own. */
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

  it('builds each plan exactly as it was pinned, so that a change of the generator is seen', () => {
    expect(PDF_SAMPLE_SIZES.map((size) => [size, fingerprint(buildPdfSample(size))])).toEqual([
      ['small', '9e98173e106ddf0f6fab3740aa0dacb3cdc06b1a9e2bf96dc6223843436d3afe'],
      ['medium', '27025c53c07e7f9c85183a454671d04c4641c00a74030c4387b6f9cbae9298ce'],
      ['large', '2a78b88bf156204a1da4c84966eb23d9a394a62327bb355eabd3544b68dd3df2'],
    ]);
  });

  it('builds the same plan from the same seed and another one from another seed', () => {
    expect(buildPdfSample('medium')).toEqual(buildPdfSample('medium'));
    expect(buildPdfSample('medium', 1)).not.toEqual(buildPdfSample('medium'));
  });
});
