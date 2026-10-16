import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AEAD_TAG_BYTES, type Aead } from '../../core/collaboration/secure/channel';

const ALGORITHM = 'aes-256-gcm';
const AUTHENTICATION_FAILURE = 'Unsupported state or unable to authenticate data';

/** Seals and opens the frames of the encrypted channel with AES-256-GCM, the tag following the encrypted bytes, a frame that does not authenticate giving null. */
export const aesGcm: Aead = {
  seal: (key, nonce, plain) => {
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AEAD_TAG_BYTES });
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  },
  open: (key, nonce, sealed) => {
    if (sealed.length < AEAD_TAG_BYTES) {
      return null;
    }
    const tagStart = sealed.length - AEAD_TAG_BYTES;
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: AEAD_TAG_BYTES });
    decipher.setAuthTag(sealed.subarray(tagStart));
    const opened = decipher.update(sealed.subarray(0, tagStart));
    try {
      return Buffer.concat([opened, decipher.final()]);
    } catch (error) {
      if (error instanceof Error && error.message === AUTHENTICATION_FAILURE) {
        return null;
      }
      throw error;
    }
  },
};

/** Draws random bytes from the generator of the system. */
export function systemRandomBytes(count: number): Uint8Array {
  return new Uint8Array(randomBytes(count));
}
