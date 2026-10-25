import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_RELAY_ADDRESS_LENGTH, MAX_RELAY_LINK_LENGTH } from '../../limits';
import { failure, success } from '../../result';
import { seededRandom } from '../../testing/test-crypto';
import { encodeBase64Url } from './base64url';
import { drawRelayAccess, viewAccessOf } from './relay-keys';
import {
  encodeRelayLink,
  hostLabelOf,
  isLoopback,
  readRelayAddress,
  readRelayLink,
  relayUrlOf,
  type RelayAddress,
} from './relay-link';

const SCHOOL: RelayAddress = { host: 'tasklace.my-school.example', port: null, path: '/' };
const EDIT = drawRelayAccess(seededRandom(7));

describe('the address of a relay a person types', () => {
  it('reads wss:// to a host name or address, with or without a port and a path, the host in lower case', () => {
    expect(
      [
        'wss://Tasklace.My-School.example',
        '  wss://tasklace.my-school.example/  ',
        'WSS://relay.example:8443/tasklace/v1',
        'wss://192.168.1.20:443',
        'wss://[2001:db8::7]/relay',
      ].map(readRelayAddress),
    ).toEqual([
      success(SCHOOL),
      success(SCHOOL),
      success({ host: 'relay.example', port: 8443, path: '/tasklace/v1' }),
      success({ host: '192.168.1.20', port: 443, path: '/' }),
      success({ host: '[2001:db8::7]', port: null, path: '/relay' }),
    ]);
  });

  it('lets ws:// through only to this computer', () => {
    expect(
      [
        'ws://localhost:47400',
        'ws://127.0.0.1:47400/',
        'ws://[::1]:47400',
        'ws://relay.example',
        'https://relay.example',
        'http://localhost',
      ].map(readRelayAddress),
    ).toEqual([
      success({ host: 'localhost', port: 47_400, path: '/' }),
      success({ host: '127.0.0.1', port: 47_400, path: '/' }),
      success({ host: '[::1]', port: 47_400, path: '/' }),
      failure('NOT_SECURE'),
      failure('NOT_SECURE'),
      failure('NOT_SECURE'),
    ]);
  });

  it('refuses what is not an address: no scheme, a bad host, port or path, a query, a fragment, or too long a text', () => {
    expect(
      [
        'relay.example',
        'wss://',
        'wss://-relay.example',
        'wss://relay..example',
        'wss://relay_example',
        'wss://relay.example:0',
        'wss://relay.example:65536',
        'wss://relay.example:abc',
        'wss://relay.example/a b',
        'wss://relay.example/?room=1',
        'wss://relay.example/#key',
        'wss://user@relay.example',
        'wss://[zz::1]',
        `wss://${'a'.repeat(64)}.example`,
        `wss://${Array.from({ length: 64 }, () => 'abcd').join('.')}`,
        `wss://relay.example/${'a'.repeat(256)}`,
        `wss://relay.example/${'a'.repeat(MAX_RELAY_ADDRESS_LENGTH)}`,
      ].map(readRelayAddress),
    ).toEqual(Array.from({ length: 17 }, () => failure('INVALID_ADDRESS')));
  });

  it('accepts labels and paths at their longest', () => {
    expect([
      readRelayAddress(`wss://${'a'.repeat(63)}.example`).ok,
      readRelayAddress(`wss://relay.example/${'a'.repeat(255)}`).ok,
      readRelayAddress('wss://relay.example:65535').ok,
    ]).toEqual([true, true, true]);
  });

  it('connects to wss:// except on this computer, and shows the host with its port', () => {
    const local = { host: 'localhost', port: 47_400, path: '/v1' };
    expect([
      relayUrlOf(SCHOOL),
      relayUrlOf(local),
      hostLabelOf(SCHOOL),
      hostLabelOf(local),
      isLoopback(local),
      isLoopback(SCHOOL),
    ]).toEqual([
      'wss://tasklace.my-school.example/',
      'ws://localhost:47400/v1',
      'tasklace.my-school.example',
      'localhost:47400',
      true,
      false,
    ]);
  });
});

describe('the link of a plan shared through a relay', () => {
  it('holds the relay before the # and the keys after it, e1 to edit and v1 to view', () => {
    const edit = encodeRelayLink({ address: SCHOOL, access: EDIT });
    const view = encodeRelayLink({ address: SCHOOL, access: viewAccessOf(EDIT) });
    expect([
      edit.split('#')[0],
      edit.split('#')[1]?.length,
      view.split('#')[0],
      view.split('#')[1]?.length,
    ]).toEqual([
      'tasklace://tasklace.my-school.example/',
      89,
      'tasklace://tasklace.my-school.example/',
      89,
    ]);
    expect([edit.split('#')[1]?.slice(0, 3), view.split('#')[1]?.slice(0, 3)]).toEqual([
      'e1.',
      'v1.',
    ]);
  });

  it('reads back the relay and the keys of either link, also pasted with spaces around', () => {
    const address = { host: 'relay.example', port: 8443, path: '/tasklace' };
    const view = viewAccessOf(EDIT);
    expect([
      readRelayLink(` ${encodeRelayLink({ address, access: EDIT })}\n`),
      readRelayLink(encodeRelayLink({ address: SCHOOL, access: view })),
    ]).toEqual([success({ address, access: EDIT }), success({ address: SCHOOL, access: view })]);
  });

  it('refuses anything else: another scheme, a broken relay, no keys, keys of another length or a key that cannot check signatures', () => {
    const edit = encodeRelayLink({ address: SCHOOL, access: EDIT });
    const [base = '', keys = ''] = edit.split('#e1.');
    const zeroKeyView = `${base}#v1.${encodeBase64Url(new Uint8Array(64))}`;
    expect(
      [
        edit.replace('tasklace://', 'https://'),
        edit.replace('tasklace://', 'tasklace://-'),
        base,
        `${base}#e2.${keys}`,
        `${base}#e1.${keys.slice(0, -1)}`,
        `${base}#e1.${keys}A`,
        `${base}#e1.${keys}+`,
        zeroKeyView,
        `${base}?x=1#e1.${keys}`,
        `${base}#e1.${'A'.repeat(MAX_RELAY_LINK_LENGTH)}`,
      ].map(readRelayLink),
    ).toEqual(Array.from({ length: 10 }, () => failure('INVALID_LINK')));
  });

  it('reads back any link it wrote, and never throws on any text', () => {
    fc.assert(
      fc.property(
        fc.record({
          host: fc.constantFrom(
            'relay.example',
            'a.b.example',
            '10.0.0.4',
            '[fd00::4]',
            'localhost',
          ),
          port: fc.option(fc.integer({ min: 1, max: 65_535 }), { nil: null }),
          path: fc.constantFrom('/', '/v1', '/tasklace/relay', '/a.b_c~d-e'),
        }),
        fc.integer({ min: 1, max: 1_000 }),
        fc.boolean(),
        (address, seed, isView) => {
          const access = drawRelayAccess(seededRandom(seed));
          const shared = isView ? viewAccessOf(access) : access;
          expect(readRelayLink(encodeRelayLink({ address, access: shared }))).toEqual(
            success({ address, access: shared }),
          );
        },
      ),
    );
    fc.assert(
      fc.property(fc.string(), (text) => {
        readRelayLink(text);
        readRelayAddress(text);
        readRelayLink(`tasklace://${text}`);
        readRelayAddress(`wss://${text}`);
      }),
    );
  });
});
