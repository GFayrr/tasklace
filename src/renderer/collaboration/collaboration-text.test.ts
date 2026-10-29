import { describe, expect, it } from 'vitest';
import english from '../locales/en.json';
import {
  collaborationFailureText,
  initialsOf,
  joinEndText,
  lostText,
  preferredAddress,
  relayEndText,
  relayFailureText,
} from './collaboration-text';
import { RELAY_ENDS } from '../../preload/bridge-contract';

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

  it('tells why joining ended, naming the host, with a common text for a plain end', () => {
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

  it('tells why the connection ended once the plan was open, with a common text for a plain end', () => {
    expect(
      (
        [
          'UNSUPPORTED_VERSION',
          'WRONG_KEY',
          'IDENTITY_TAKEN',
          'TURNED_AWAY',
          'TRY_LATER',
          'HOST_LEFT',
          'TAMPERED',
          'WIRE_CLOSED',
          null,
        ] as const
      ).map((reason) => lostText(english, reason, 'Camille')),
    ).toEqual([
      'Camille uses another version of Tasklace. You both need the same version to share a plan. The plan stays open on this computer.',
      'Camille no longer takes the key this computer holds for the plan. Ask Camille for the code to join again. The plan stays open on this computer.',
      'Someone else already came into the plan in your place. Ask Camille for the code to join again. The plan stays open on this computer.',
      'Camille could not take you in: the plan already has as many people as it can. The plan stays open on this computer.',
      'Camille received too many tries at once. Wait a moment, then try again. The plan stays open on this computer.',
      'Camille stopped sharing the plan. The plan stays open on this computer.',
      'The connection to Camille broke: what came through it was not what Tasklace expects. The plan stays open on this computer.',
      'The connection to Camille ended. The plan stays open on this computer.',
      'The connection to Camille ended. The plan stays open on this computer.',
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

describe('the texts of a plan shared through a relay', () => {
  it('tells why a relay refused or left a plan, one text for each reason, naming the relay', () => {
    expect(RELAY_ENDS.map((reason) => relayEndText(english, reason, 'relay.example'))).toEqual([
      'The relay relay.example uses another version of Tasklace, so it cannot take this plan.',
      'The relay relay.example sent something Tasklace could not read, so Tasklace stopped using it.',
      'This plan is not on the relay relay.example: it was given new links, nobody opened it for a long time, or the relay lost it. Ask who sent you the link, or forget this shared plan in “Share”.',
      'The relay relay.example already holds a plan in that place. Share the plan again.',
      'The relay relay.example refused a change that the link to edit did not sign.',
      'The relay keeps no more for this plan: it reached the size its owner allows. Your changes are kept on this computer.',
      'This plan already has as many people as the relay relay.example takes. Try again later.',
      'The relay relay.example takes no more plans for now. Try again later, or ask its owner.',
      'Too many connections come from your network to the relay relay.example. Try again later.',
      'Tasklace sent too much to the relay relay.example at once. Try again in a moment.',
      'The relay relay.example refused a change made before the plan was tidied up on it. Tasklace sends it again once back in the plan.',
      'The relay relay.example could not keep this plan because of a problem on its side. Try again later, or ask its owner to check its log.',
      'This plan was given new links, so its old place on the relay is empty. Ask who shared it for the new links.',
      'The relay relay.example did not answer. Check your connection, or ask who sent you the link.',
      'The relay relay.example could not prove who it is, so Tasklace does not use it. Ask its owner to check its certificate.',
    ]);
  });

  it('tells why a plan could not be shared or joined through a relay, an address of its own included, and nothing for a cancelled choice', () => {
    expect([
      relayFailureText(english, { code: 'RELAY_ENDED', reason: 'UNREACHABLE' }, 'relay.example'),
      relayFailureText(english, { code: 'INVALID_ADDRESS' }, 'relay'),
      relayFailureText(english, { code: 'NOT_SECURE' }, 'relay.example'),
      relayFailureText(english, { code: 'CANCELLED' }, 'relay.example'),
    ]).toEqual([
      'The relay relay.example did not answer. Check your connection, or ask who sent you the link.',
      english.relay.invalidAddress,
      english.fileErrors.NOT_SECURE,
      null,
    ]);
  });
});
