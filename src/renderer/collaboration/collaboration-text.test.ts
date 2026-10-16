import { describe, expect, it } from 'vitest';
import english from '../locales/en.json';
import {
  collaborationFailureText,
  initialsOf,
  joinEndText,
  preferredAddress,
} from './collaboration-text';

const PLAN = { key: 'k', planName: 'Thesis', hostName: 'Camille', port: 47_313 };

describe('the texts of a shared plan', () => {
  it('gives the first two characters of a name in capitals, as a reader sees them', () => {
    expect(
      ['Camille', ' léa ', 'Ö', 'émile', '👩🏽‍🔬 Ada', ''].map((name) => initialsOf(name, 'en')),
    ).toEqual(['CA', 'LÉ', 'Ö', 'ÉM', '👩🏽‍🔬 ', '']);
  });

  it('tells why a plan could not be shared, a missing name included, and nothing for a cancelled choice', () => {
    expect([
      collaborationFailureText(english, { code: 'NO_NAME' }),
      collaborationFailureText(english, { code: 'NO_FREE_PORT' }),
      collaborationFailureText(english, { code: 'CANCELLED' }),
    ]).toEqual([english.collaboration.noName, english.fileErrors.NO_FREE_PORT, null]);
  });

  it('tells why joining ended, naming the host, with a common text for the other reasons', () => {
    expect(
      (['WRONG_CODE', 'CODE_REPLACED', 'UNREACHABLE', 'NOT_PRIVATE', 'TIMEOUT'] as const).map(
        (reason) => joinEndText(english, reason, 'Camille'),
      ),
    ).toEqual([
      'This code did not work. Check it with Camille and type it again.',
      'This code is no longer valid: too many wrong tries. Ask Camille for the new one.',
      'Tasklace could not reach Camille at this address. Check the address and the port, and that you are on the same network.',
      'This address is not on a private network, so Tasklace does not join it.',
      'The connection to Camille ended before the plan opened. Try again.',
    ]);
  });

  it('prefers the first IPv4 address of a plan found nearby, then its first address, or none', () => {
    expect([
      preferredAddress({ ...PLAN, addresses: ['fe80::1', '192.168.1.24', '10.0.0.2'] }),
      preferredAddress({ ...PLAN, addresses: ['fe80::1', 'fd00::2'] }),
      preferredAddress({ ...PLAN, addresses: [] }),
    ]).toEqual(['192.168.1.24', 'fe80::1', null]);
  });
});
