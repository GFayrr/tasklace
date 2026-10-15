import { describe, expect, it } from 'vitest';
import { isOneOf } from './one-of';

describe('isOneOf', () => {
  it('tells whether a value is exactly one of the choices', () => {
    const choices = ['a4', 'a3'] as const;
    expect([
      isOneOf(choices, 'a4'),
      isOneOf(choices, 'A4'),
      isOneOf(choices, 4),
      isOneOf([], 'a4'),
    ]).toEqual([true, false, false, false]);
  });
});
