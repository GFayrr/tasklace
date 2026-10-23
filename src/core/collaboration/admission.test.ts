import { describe, expect, it } from 'vitest';
import {
  ADDRESS_HANDSHAKE_BURST,
  ADDRESS_HANDSHAKES_PER_SECOND,
  HANDSHAKE_BURST,
  MAX_THROTTLED_ADDRESSES,
  MAX_WRONG_CODE_WAIT_MILLISECONDS,
} from '../limits';
import { createAdmission, wrongCodeWait } from './admission';

const SECOND = 1_000;

/** Builds an admission on a clock the test moves by hand. */
function admissionAt() {
  let time = 0;
  const admission = createAdmission(() => time);
  return {
    admission,
    move: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

/** Counts how many of a number of tries from an address are let in at once. */
function letIn(admit: (address: string) => boolean, address: string, tries: number): number {
  return Array.from({ length: tries }, () => admit(address)).filter(Boolean).length;
}

describe('how fast a host lets connections in', () => {
  it('lets an address in a burst at once, then as many each second as its rate', () => {
    const { admission, move } = admissionAt();
    expect(letIn(admission.admit, '192.168.1.24', ADDRESS_HANDSHAKE_BURST + 1)).toBe(
      ADDRESS_HANDSHAKE_BURST,
    );
    move(SECOND);
    expect(letIn(admission.admit, '192.168.1.24', ADDRESS_HANDSHAKE_BURST)).toBe(
      ADDRESS_HANDSHAKES_PER_SECOND,
    );
  });

  it('limits everyone together, whatever the number of addresses', () => {
    const { admission } = admissionAt();
    const admitted = Array.from({ length: HANDSHAKE_BURST + 1 }, (_unused, index) =>
      admission.admit(`10.0.0.${String(index)}`),
    ).filter(Boolean).length;
    expect(admitted).toBe(HANDSHAKE_BURST);
  });

  it('lets an address try again at once after one wrong code, then makes it wait longer after each', () => {
    const { admission, move } = admissionAt();
    admission.wrongCode('192.168.1.24');
    expect(admission.admit('192.168.1.24')).toBe(true);
    admission.wrongCode('192.168.1.24');
    expect([admission.admit('192.168.1.24'), admission.admit('192.168.1.25')]).toEqual([
      false,
      true,
    ]);
    move(wrongCodeWait(2));
    expect(admission.admit('192.168.1.24')).toBe(true);
    admission.joined('192.168.1.24');
    admission.wrongCode('192.168.1.24');
    expect(admission.admit('192.168.1.24')).toBe(true);
  });

  it('doubles the wait after each wrong code, up to a limit', () => {
    expect([1, 2, 3, 4, 7, 40].map(wrongCodeWait)).toEqual([
      0,
      1_024,
      2_048,
      4_096,
      MAX_WRONG_CODE_WAIT_MILLISECONDS,
      MAX_WRONG_CODE_WAIT_MILLISECONDS,
    ]);
  });

  it('forgets the oldest address once it remembers as many as it may', () => {
    const { admission } = admissionAt();
    admission.wrongCode('first');
    admission.wrongCode('first');
    for (let index = 0; index < MAX_THROTTLED_ADDRESSES; index += 1) {
      admission.joined(`other-${String(index)}`);
    }
    expect(admission.admit('first')).toBe(true);
  });
});
