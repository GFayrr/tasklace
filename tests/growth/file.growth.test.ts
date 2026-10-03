import { describe, expect, it } from 'vitest';
import { encodeTasklaceFile, readTasklaceFile } from '../../src/core/file/tasklace-file';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import {
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SMALL_TASK_COUNT,
} from './measure-growth';
import { TEST_DOCUMENT_ID } from '../../src/core/testing/project-builder';

/** Writes the large project with a given number of tasks as a .tasklace file. */
function fileOf(taskCount: number): Uint8Array {
  return encodeTasklaceFile(
    createSharedDocument(buildLargeProject(LARGE_PROJECT_SEED, taskCount), TEST_DOCUMENT_ID),
    zlibCompressor,
  );
}

describe('growth of reading a .tasklace file with the size of the project', () => {
  it('reads and validates a file in linear time', () => {
    const small = fileOf(SMALL_TASK_COUNT);
    const large = fileOf(LARGE_TASK_COUNT);
    const ratio = growthRatio(
      () => readTasklaceFile(small, zlibCompressor),
      () => readTasklaceFile(large, zlibCompressor),
    );
    console.info(`File reading: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});

describe('growth of writing a .tasklace file with the size of the project', () => {
  it('encodes and compresses a project in linear time', () => {
    const small = createSharedDocument(
      buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT),
      TEST_DOCUMENT_ID,
    );
    const large = createSharedDocument(
      buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT),
      TEST_DOCUMENT_ID,
    );
    const ratio = growthRatio(
      () => encodeTasklaceFile(small, zlibCompressor),
      () => encodeTasklaceFile(large, zlibCompressor),
    );
    console.info(`File writing: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
