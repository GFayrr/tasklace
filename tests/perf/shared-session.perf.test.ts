import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { openSharedSession, type SharedSession } from '../../src/core/shared/shared-session';
import { buildLargeProject } from '../fixtures/large-project';
import { TEST_DOCUMENT_ID } from '../../src/core/testing/project-builder';
import { medianDuration } from '../growth/measure-growth';

const FRAME_MILLISECONDS = 16;
const MEASURED_RUNS = 9;

/** Opens a session on a copy of a document, failing the test when it cannot be opened. */
function openCopy(document: Y.Doc): SharedSession {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  const session = openSharedSession(copy);
  if (!session.ok) {
    throw new Error(JSON.stringify(session.error));
  }
  return session.value;
}

describe('shared session performance (10,000 tasks, 20,000 dependencies)', () => {
  const origin = createSharedDocument(buildLargeProject(), TEST_DOCUMENT_ID);
  const local = openCopy(origin);
  const remote = openCopy(origin);

  it(`applies a local edit in less than ${String(FRAME_MILLISECONDS)} ms`, () => {
    const duration = medianDuration((index) => {
      const task = local.project().tasks[index];
      if (task !== undefined) {
        local.apply({ type: 'putTask', task: { ...task, name: `Edited ${String(index)}` } });
      }
    }, MEASURED_RUNS);
    console.info(`Local edit: ${duration.toFixed(2)} ms`);
    expect(duration).toBeLessThan(FRAME_MILLISECONDS);
  });

  it(`merges a received edit in less than ${String(FRAME_MILLISECONDS)} ms`, () => {
    const updates: Uint8Array[] = [];
    remote.document.on('update', (update: Uint8Array) => {
      updates.push(update);
    });
    for (let index = 0; index <= MEASURED_RUNS; index += 1) {
      const task = remote.project().tasks[100 + index];
      if (task !== undefined) {
        remote.apply({ type: 'putTask', task: { ...task, name: `Remote ${String(index)}` } });
      }
    }
    const receiver = openCopy(origin);
    let next = 0;
    const duration = medianDuration(() => {
      const merged = receiver.merge(updates[next] ?? new Uint8Array());
      next += 1;
      expect(merged.ok).toBe(true);
    }, MEASURED_RUNS);
    console.info(`Received edit: ${duration.toFixed(2)} ms`);
    expect(duration).toBeLessThan(FRAME_MILLISECONDS);
  });
});
