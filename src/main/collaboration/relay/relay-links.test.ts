import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawRelayAccess, viewAccessOf } from '../../../core/collaboration/relay/relay-keys';
import { encodeRelayLink, type RelayLink } from '../../../core/collaboration/relay/relay-link';
import type { DocumentId } from '../../../core/shared/shared-document';
import { forgedDocumentId } from '../../../core/testing/project-builder';
import { seededRandom } from '../../../core/testing/test-crypto';
import {
  createRelayLinkStore,
  readLinkStore,
  vaultOf,
  type SystemSafeStorage,
  type Vault,
} from './relay-links';

const PLAN = forgedDocumentId('8a1d2f3c-4b5e-4f60-8a7b-9c0d1e2f3a4b');
const OTHER_PLAN = forgedDocumentId('1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d');
const EDIT_LINK: RelayLink = {
  address: { host: 'relay.example.org', port: null, path: '/' },
  access: drawRelayAccess(seededRandom(61)),
};
const VIEW_LINK: RelayLink = { ...EDIT_LINK, access: viewAccessOf(EDIT_LINK.access) };
const SCRAMBLE = 0x5a;

let folder: string;
let storePath: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'tasklace-links-'));
  storePath = path.join(folder, 'relay-links.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

/** Gives a vault that scrambles what it seals, as the vault of the system would, and can be made unavailable or unable to open. */
function fakeVault(
  state: { available: boolean; opens: boolean } = { available: true, opens: true },
) {
  const vault: Vault = {
    isAvailable: () => state.available,
    seal: (text) => new TextEncoder().encode(text).map((byte) => byte ^ SCRAMBLE),
    open: (sealed) => {
      if (!state.opens) {
        throw new Error(
          'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
        );
      }
      return new TextDecoder().decode(sealed.map((byte) => byte ^ SCRAMBLE));
    },
  };
  return { vault, state };
}

/** Gives the plans whose links the store file holds, in its order. */
async function storedPlans(): Promise<string[]> {
  return readLinkStore(await readFile(storePath, 'utf8')).links.map((link) => link.documentId);
}

/** Gives the link a store finds for a plan as text, null when it keeps none, or why it cannot be read. */
async function foundText(
  store: ReturnType<typeof createRelayLinkStore>,
  documentId: DocumentId,
): Promise<string | null> {
  const found = await store.find(documentId);
  if (!found.ok) {
    return found.error;
  }
  return found.value === null ? null : encodeRelayLink(found.value);
}

describe('the links of shared plans kept on this computer', () => {
  it('keeps the link of a plan sealed by the vault, never in clear, and finds it again', async () => {
    const store = createRelayLinkStore(storePath, fakeVault().vault);
    const kept = await store.keep(PLAN, EDIT_LINK);
    const onDisk = await readFile(storePath, 'utf8');
    expect([
      kept,
      await foundText(store, PLAN),
      await foundText(createRelayLinkStore(storePath, fakeVault().vault), PLAN),
      await foundText(store, OTHER_PLAN),
      onDisk.includes(encodeRelayLink(EDIT_LINK).split('#')[1] ?? ''),
      onDisk.includes('relay.example.org'),
    ]).toEqual([
      { ok: true, value: undefined },
      encodeRelayLink(EDIT_LINK),
      encodeRelayLink(EDIT_LINK),
      null,
      false,
      false,
    ]);
  });

  it('keeps nothing while the vault does not protect what it holds, and tells a link kept before that it cannot open from no link at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { vault, state } = fakeVault();
    const store = createRelayLinkStore(storePath, vault);
    await store.keep(PLAN, EDIT_LINK);
    state.available = false;
    expect([
      await store.keep(OTHER_PLAN, VIEW_LINK),
      await foundText(store, PLAN),
      await foundText(store, OTHER_PLAN),
      (await storedPlans()).length,
      warn.mock.calls,
    ]).toEqual([
      { ok: false, error: 'NO_SAFE_STORAGE' },
      'LINK_UNREADABLE',
      null,
      1,
      [['The link of a shared plan is kept, but the vault of the system cannot open it now.']],
    ]);
  });

  it('keeps one link per plan, the one kept last, and the most recent plans first', async () => {
    const store = createRelayLinkStore(storePath, fakeVault().vault);
    await store.keep(PLAN, EDIT_LINK);
    await store.keep(OTHER_PLAN, EDIT_LINK);
    await store.keep(PLAN, VIEW_LINK);
    expect([await storedPlans(), await foundText(store, PLAN)]).toEqual([
      [PLAN, OTHER_PLAN],
      encodeRelayLink(VIEW_LINK),
    ]);
  });

  it('keeps the links of two plans kept at the same time', async () => {
    const store = createRelayLinkStore(storePath, fakeVault().vault);
    await Promise.all([store.keep(PLAN, EDIT_LINK), store.keep(OTHER_PLAN, VIEW_LINK)]);
    expect([await foundText(store, PLAN), await foundText(store, OTHER_PLAN)]).toEqual([
      encodeRelayLink(EDIT_LINK),
      encodeRelayLink(VIEW_LINK),
    ]);
  });

  it('forgets the link of a plan, writing nothing for a plan it does not hold', async () => {
    const store = createRelayLinkStore(storePath, fakeVault().vault);
    await store.forget(PLAN);
    const before = await readdir(folder);
    await store.keep(PLAN, EDIT_LINK);
    await store.keep(OTHER_PLAN, EDIT_LINK);
    await store.forget(PLAN);
    expect([before, await foundText(store, PLAN), await foundText(store, OTHER_PLAN)]).toEqual([
      [],
      null,
      encodeRelayLink(EDIT_LINK),
    ]);
  });

  it('warns and cannot read a link the vault no longer opens or that is not a link', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { vault, state } = fakeVault();
    const store = createRelayLinkStore(storePath, vault);
    await store.keep(PLAN, EDIT_LINK);
    const notALink = Buffer.from(vault.seal('tasklace://nothing')).toString('base64');
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, links: [{ documentId: OTHER_PLAN, sealed: notALink }] }),
    );
    const notOpened = await foundText(store, OTHER_PLAN);
    await store.keep(PLAN, EDIT_LINK);
    state.opens = false;
    expect([
      notOpened,
      await foundText(store, PLAN),
      warn.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      'LINK_UNREADABLE',
      'LINK_UNREADABLE',
      [
        'The link kept for a shared plan is not a link.',
        'The link of a shared plan could not be opened:',
      ],
    ]);
  });

  it('sets a damaged store aside and writes back the entries it could read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { vault } = fakeVault();
    const sealed = Buffer.from(vault.seal(encodeRelayLink(EDIT_LINK))).toString('base64');
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        links: [
          { documentId: PLAN, sealed },
          { documentId: PLAN, sealed },
          { documentId: 'not an identifier', sealed },
          { documentId: OTHER_PLAN, sealed: 'not base64!' },
          { documentId: OTHER_PLAN, sealed, more: true },
          'a text',
        ],
      }),
    );
    const store = createRelayLinkStore(storePath, vault);
    const found = await foundText(store, PLAN);
    const files = (await readdir(folder)).sort();
    expect([
      found,
      files.length,
      files[1]?.startsWith('relay-links.json.damaged-'),
      JSON.parse(await readFile(storePath, 'utf8')) as unknown,
      error.mock.calls.length,
    ]).toEqual([
      encodeRelayLink(EDIT_LINK),
      2,
      true,
      { version: 1, links: [{ documentId: PLAN, sealed }] },
      1,
    ]);
  });
});

describe('reading the store of links', () => {
  it.each([
    ['an empty text from a missing store', '', { links: [], damaged: false }],
    ['text that is not JSON', '{', { links: [], damaged: true }],
    ['another version', '{"version":2,"links":[]}', { links: [], damaged: true }],
    ['links that are not a list', '{"version":1,"links":{}}', { links: [], damaged: true }],
    ['an empty list', '{"version":1,"links":[]}', { links: [], damaged: false }],
  ])('reads %s', (_name, text, reading) => {
    expect(readLinkStore(text)).toEqual(reading);
  });

  it('refuses a sealed link longer than the limit', () => {
    const text = JSON.stringify({
      version: 1,
      links: [{ documentId: PLAN, sealed: 'A'.repeat(4_097) }],
    });
    expect(readLinkStore(text)).toEqual({ links: [], damaged: true });
  });
});

describe('the vault of the system', () => {
  /** Gives a fake of the safe storage of Electron with an encryption state and a store of Linux. */
  function storage(available: boolean, backend: string): SystemSafeStorage {
    return {
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () =>
        backend as ReturnType<SystemSafeStorage['getSelectedStorageBackend']>,
      encryptString: (text) => Buffer.from(`sealed:${text}`),
      decryptString: (sealed) => sealed.toString().slice('sealed:'.length),
    };
  }

  it.each([
    ['Windows', 'win32', true, 'unknown', true],
    ['Windows without encryption', 'win32', false, 'unknown', false],
    ['a Linux keyring', 'linux', true, 'gnome_libsecret', true],
    ['the plain text store of Linux', 'linux', true, 'basic_text', false],
    ['Linux before it is ready', 'linux', true, 'unknown', false],
  ] as const)(
    'is available on %s only when it protects what it holds',
    (_name, platform, available, backend, expected) => {
      expect(vaultOf(storage(available, backend), platform).isAvailable()).toBe(expected);
    },
  );

  it('seals and opens through the safe storage of Electron', () => {
    const vault = vaultOf(storage(true, 'unknown'), 'win32');
    const sealed = vault.seal('a link');
    expect([Buffer.from(sealed).toString(), vault.open(sealed)]).toEqual([
      'sealed:a link',
      'a link',
    ]);
  });
});
