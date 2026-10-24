import { describe, expect, it } from 'vitest';
import { createIssueList } from '../validation/validation-issues';
import { readEndpoint } from './endpoint';

/** Reads an endpoint from a value, giving what was read and the problems noted. */
function read(value: unknown) {
  const issues = createIssueList();
  return { endpoint: readEndpoint({ value, path: 'endpoint' }, issues), issues: issues.issues };
}

describe('readEndpoint', () => {
  it('reads the addresses and the port where a participant could host the plan', () => {
    expect(read({ addresses: ['192.168.1.24', 'fe80::1%eth0'], port: 47_313 })).toEqual({
      endpoint: { addresses: ['192.168.1.24', 'fe80::1%eth0'], port: 47_313 },
      issues: [],
    });
  });

  it('notes where an address is not written as one, refusing the endpoint', () => {
    expect([
      read({ addresses: ['192.168.1.24', 'a b'], port: 47_313 }),
      read({ addresses: [7], port: 47_313 }),
    ]).toEqual([
      { endpoint: undefined, issues: [{ path: 'endpoint.addresses[1]', code: 'INVALID_TEXT' }] },
      { endpoint: undefined, issues: [{ path: 'endpoint.addresses[0]', code: 'INVALID_TEXT' }] },
    ]);
  });
});
