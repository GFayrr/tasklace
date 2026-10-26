import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeMessage } from '../messages';
import { readRelayLog } from './relay-log';

const merging = vi.hoisted(() => ({ throwsText: false }));

vi.mock('../../limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../limits')>()),
  MAX_UNCOMPRESSED_BYTES: 8,
}));

vi.mock('yjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('yjs')>();
  return {
    ...original,
    mergeUpdates: (updates: Uint8Array[]) => {
      if (merging.throwsText) {
        const failure: unknown = 'not an error';
        throw failure;
      }
      return original.mergeUpdates(updates);
    },
  };
});

afterEach(() => {
  merging.throwsText = false;
});

describe('reading the log a relay passed on, within its limits', () => {
  it('refuses a log whose changes are larger than a file', () => {
    const messages = [
      encodeMessage({ kind: 'update', update: new Uint8Array(5) }),
      encodeMessage({ kind: 'update', update: new Uint8Array(4) }),
    ];
    expect(readRelayLog(messages)).toEqual({ ok: false, error: { code: 'TOO_LARGE' } });
  });

  it('passes on a value thrown while merging that is not an error', () => {
    merging.throwsText = true;
    expect(() =>
      readRelayLog([encodeMessage({ kind: 'update', update: new Uint8Array(2) })]),
    ).toThrow('not an error');
  });
});
