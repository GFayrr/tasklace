import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { openSharedSession } from '../../src/core/shared/shared-session';
import { TEST_DOCUMENT_ID } from '../../src/core/testing/project-builder';
import { buildPlanOutline, groupIncoming } from '../../src/renderer/plan/plan-outline';
import { tagStylesOf } from '../../src/renderer/plan/tag-styles';
import { buildLargeProject } from '../fixtures/large-project';

const FRAME_MILLISECONDS = 16;
const MEASURED_RUNS = 9;

/** Runs a function several times after a warm-up and returns the median duration in milliseconds. */
function medianDuration(run: (index: number) => void): number {
  run(MEASURED_RUNS);
  const durations = Array.from({ length: MEASURED_RUNS }, (_unused, index) => {
    const start = performance.now();
    run(index);
    return performance.now() - start;
  }).sort((left, right) => left - right);
  return durations[Math.floor(MEASURED_RUNS / 2)] ?? Number.POSITIVE_INFINITY;
}

describe('interface refresh after an edit (10,000 tasks, 20,000 dependencies)', () => {
  const document = new Y.Doc();
  Y.applyUpdate(
    document,
    Y.encodeStateAsUpdate(createSharedDocument(buildLargeProject(), TEST_DOCUMENT_ID)),
  );
  const opened = openSharedSession(document);
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error));
  }
  const session = opened.value;
  const tasks = session.project().tasks;

  it(`renames a task and prepares what the interface shows in less than ${String(FRAME_MILLISECONDS)} ms`, () => {
    const duration = medianDuration((index) => {
      const task = tasks[index];
      if (task !== undefined) {
        session.apply({ type: 'putTask', task: { ...task, name: `Renamed ${String(index)}` } });
      }
      const project = session.project();
      buildPlanOutline(project.tasks, new Set());
      groupIncoming(project.dependencies);
      tagStylesOf(project);
    });
    console.info(`Edit and interface refresh: ${duration.toFixed(1)} ms`);
    expect(duration).toBeLessThan(FRAME_MILLISECONDS);
  });
});
