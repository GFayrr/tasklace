import { describe, expect, it } from 'vitest';
import { isPort } from './ports';

describe('the ports of a shared plan', () => {
  it('accepts the whole ports from 1 to 65535', () => {
    expect([0, 1, 47_313, 65_535, 65_536, 1.5, Number.NaN].map(isPort)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
