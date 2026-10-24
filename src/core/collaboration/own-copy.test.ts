import { describe, expect, it } from 'vitest';
import { MAX_PROJECT_NAME_LENGTH } from '../limits';
import { ownCopyName } from './own-copy';

const TEMPLATE = '{plan} (my changes)';

describe('ownCopyName', () => {
  it('names the copy after the shared plan', () => {
    expect(ownCopyName('Thesis plan', TEMPLATE)).toBe('Thesis plan (my changes)');
  });

  it('cuts a long plan name by code points so that the whole name stays within the limit', () => {
    const name = ownCopyName('📝'.repeat(MAX_PROJECT_NAME_LENGTH), TEMPLATE);
    expect([name, Array.from(name).length]).toEqual([
      `${'📝'.repeat(MAX_PROJECT_NAME_LENGTH - 13)} (my changes)`,
      MAX_PROJECT_NAME_LENGTH,
    ]);
  });

  it('drops the spaces a cut leaves at the end of the plan name', () => {
    const plan = `${'a'.repeat(MAX_PROJECT_NAME_LENGTH - 14)} b`;
    expect(ownCopyName(plan, TEMPLATE)).toBe(
      `${'a'.repeat(MAX_PROJECT_NAME_LENGTH - 14)} (my changes)`,
    );
  });
});
