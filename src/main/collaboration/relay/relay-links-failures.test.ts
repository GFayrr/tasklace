import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawRelayAccess } from '../../../core/collaboration/relay/relay-keys';
import { encodeRelayLink, type RelayLink } from '../../../core/collaboration/relay/relay-link';
import { forgedDocumentId } from '../../../core/testing/project-builder';
import { seededRandom } from '../../../core/testing/test-crypto';
import { createRelayLinkStore, type Vault } from './relay-links';

const failing = vi.hoisted(() => ({ write: false }));

vi.mock('../../safe-write', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../safe-write')>();
  return {
    ...original,
    writeFileSafely: (...args: Parameters<typeof original.writeFileSafely>) =>
      failing.write
        ? Promise.reject(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }))
        : original.writeFileSafely(...args),
  };
});

const PLAN = forgedDocumentId('8a1d2f3c-4b5e-4f60-8a7b-9c0d1e2f3a4b');
const LINK: RelayLink = {
  address: { host: 'relay.example.org', port: null, path: '/' },
  access: drawRelayAccess(seededRandom(62)),
};
const PLAIN_VAULT: Vault = {
  isAvailable: () => true,
  seal: (text) => new TextEncoder().encode(text),
  open: (sealed) => new TextDecoder().decode(sealed),
};

let folder: string;
let storePath: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'tasklace-links-'));
  storePath = path.join(folder, 'relay-links.json');
  failing.write = false;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

describe('the links of shared plans when the disk fails', () => {
  it('passes on a link that cannot be written, and still runs the steps that follow', async () => {
    const store = createRelayLinkStore(storePath, PLAIN_VAULT);
    failing.write = true;
    const refused = await store.keep(PLAN, LINK).catch((error: unknown) => error);
    failing.write = false;
    await store.keep(PLAN, LINK);
    const found = await store.find(PLAN);
    expect([
      refused instanceof Error ? refused.message : refused,
      found === null ? null : encodeRelayLink(found),
    ]).toEqual(['No space left on device', encodeRelayLink(LINK)]);
  });

  it('logs a repaired store that cannot be written back, still giving the entries it read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sealed = Buffer.from(encodeRelayLink(LINK)).toString('base64');
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, links: [{ documentId: PLAN, sealed }, 'a text'] }),
    );
    failing.write = true;
    const found = await createRelayLinkStore(storePath, PLAIN_VAULT).find(PLAN);
    expect([
      found === null ? null : encodeRelayLink(found),
      error.mock.calls.map(([message]: unknown[]) => message).at(-1),
    ]).toEqual([encodeRelayLink(LINK), 'The repaired links of shared plans could not be written:']);
  });
});
