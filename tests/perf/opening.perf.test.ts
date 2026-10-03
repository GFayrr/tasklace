import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { encodeTasklaceFile, readTasklaceFile } from '../../src/core/file/tasklace-file';
import { scheduleProject } from '../../src/core/scheduling/schedule-project';
import { createSharedDocument, readDocumentId } from '../../src/core/shared/shared-document';
import { openSharedSession } from '../../src/core/shared/shared-session';
import { TEST_DOCUMENT_ID } from '../../src/core/testing/project-builder';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { buildLargeProject } from '../fixtures/large-project';

const TARGET_MILLISECONDS = 2_000;
const MEASURED_RUNS = 3;

/** Opens a project file the way the application does: the worker reads, checks and re-encodes it, then the page rebuilds its session and asks for its first schedule. */
function openFile(file: Uint8Array): void {
  const read = readTasklaceFile(file, zlibCompressor);
  if (!read.ok || readDocumentId(read.value) === null) {
    throw new Error('File refused');
  }
  const state = Y.encodeStateAsUpdate(read.value);
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  const session = openSharedSession(document);
  if (!session.ok || !scheduleProject(session.value.project()).ok) {
    throw new Error('Project refused');
  }
}

/** Runs a function several times after a warm-up and returns the median duration in milliseconds. */
function medianDuration(run: () => void): number {
  run();
  const durations = Array.from({ length: MEASURED_RUNS }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((left, right) => left - right);
  return durations[Math.floor(MEASURED_RUNS / 2)] ?? Number.POSITIVE_INFINITY;
}

describe('opening performance (10,000 tasks, 20,000 dependencies)', () => {
  const file = encodeTasklaceFile(
    createSharedDocument(buildLargeProject(), TEST_DOCUMENT_ID),
    zlibCompressor,
  );

  it(`opens a project file in less than ${String(TARGET_MILLISECONDS)} ms`, () => {
    const duration = medianDuration(() => {
      openFile(file);
    });
    console.info(`Opening: ${duration.toFixed(0)} ms`);
    expect(duration).toBeLessThan(TARGET_MILLISECONDS);
  });
});
