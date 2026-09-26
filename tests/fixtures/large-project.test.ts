import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LARGE_PROJECT_SEED, buildLargeProject } from './large-project';
import { createRandom } from './random';

const LARGE_PROJECT_FINGERPRINT =
  '8d6643a1e533d89a30fed1a2bf926fc0c19701505f2dbe6a9dbecf0e20d76803';

/** Returns the SHA-256 fingerprint of a value serialized as JSON. */
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

describe('createRandom', () => {
  it('returns the same sequence for the same seed and numbers in [0, 1)', () => {
    const first = createRandom(42);
    const second = createRandom(42);
    const values = Array.from({ length: 1_000 }, () => first());
    expect(values).toEqual(Array.from({ length: 1_000 }, () => second()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('returns different sequences for different seeds', () => {
    expect(createRandom(1)()).not.toBe(createRandom(2)());
  });
});

describe('buildLargeProject', () => {
  it('generates 10,000 tasks and 20,000 dependencies', () => {
    const generated = buildLargeProject();
    expect(generated.tasks).toHaveLength(10_000);
    expect(generated.dependencies).toHaveLength(20_000);
  });

  it('generates exactly the same project on every machine for the fixed seed', () => {
    expect(fingerprint(buildLargeProject(LARGE_PROJECT_SEED))).toBe(LARGE_PROJECT_FINGERPRINT);
  });

  it('generates a different project for another seed', () => {
    expect(fingerprint(buildLargeProject(LARGE_PROJECT_SEED + 1))).not.toBe(
      LARGE_PROJECT_FINGERPRINT,
    );
  });
});
