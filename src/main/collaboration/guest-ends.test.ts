import { describe, expectTypeOf, it } from 'vitest';
import type { GuestEndReason } from '../../preload/bridge-contract';
import type { GuestEnd } from './guest-client';

describe('the reasons a guest connection ends', () => {
  it('are the same for the main process and the bridge of the page, so that no reason is missing or left over', () => {
    expectTypeOf<GuestEnd>().toEqualTypeOf<GuestEndReason>();
  });
});
