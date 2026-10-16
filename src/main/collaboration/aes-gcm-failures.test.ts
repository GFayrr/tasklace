import { describe, expect, it, vi } from 'vitest';
import { AEAD_TAG_BYTES, NONCE_BYTES } from '../../core/collaboration/secure/channel';
import { aesGcm } from './aes-gcm';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createDecipheriv: (...parts: Parameters<typeof actual.createDecipheriv>) => {
      const decipher = actual.createDecipheriv(...parts);
      return Object.assign(decipher, {
        final: () => {
          throw new Error('The cipher stopped');
        },
      });
    },
  };
});

describe('AES-256-GCM when opening fails for another reason than authentication', () => {
  it('throws the error rather than taking it for a changed frame', () => {
    expect(() =>
      aesGcm.open(new Uint8Array(32), new Uint8Array(NONCE_BYTES), new Uint8Array(AEAD_TAG_BYTES)),
    ).toThrow('The cipher stopped');
  });
});
