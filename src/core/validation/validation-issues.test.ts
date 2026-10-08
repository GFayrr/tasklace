import { describe, expect, it } from 'vitest';
import { requireIssues } from './validation-issues';

describe('requireIssues', () => {
  it('keeps every issue of a refusal, in order', () => {
    const issues = [
      { path: 'name', code: 'EMPTY_TEXT' },
      { path: 'tasks', code: 'TOO_MANY_ITEMS' },
    ] as const;
    expect(requireIssues(issues)).toEqual(issues);
  });

  it('throws on a refusal without any issue, since every refusal has a reason', () => {
    expect(() => requireIssues([])).toThrow('A refusal holds no issue.');
  });
});
