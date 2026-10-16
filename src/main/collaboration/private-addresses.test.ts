import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from './private-addresses';

describe('private addresses', () => {
  it.each([
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.3.4',
    '127.0.0.1',
    '::ffff:192.168.1.20',
    '::FFFF:10.0.0.1',
    'fd12:3456::1',
    'fe80::1%eth0',
    'FE80::abcd',
    '::1',
  ])('accepts %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    '::',
    'localhost',
    '',
    '192.168.1',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});
