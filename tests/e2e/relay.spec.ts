import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import english from '../../src/renderer/locales/en.json' with { type: 'json' };
import { closeDiscarding, launchApplication } from './application';
import { startTcpRelay, type TcpRelay } from '../../src/main/testing/tcp-relay';
import { writeRelayCertificate } from '../../src/main/testing/test-certificate';
import { picture } from './pictures';

const RELAY_MAIN = join(import.meta.dirname, '..', '..', 'relay', 'src', 'main.ts');
const RELAY_STARTED = /port (\d+)\./;
const LOOPBACK = '127.0.0.1';
const UNPROTECTED_BACKENDS: readonly string[] = ['basic_text', 'unknown'];
const RELAY = english.relay;
const THREE_INSTANCES_TEST_MS = 120_000;
const RELAY_DOWN_TEST_MS = 120_000;

interface Instance {
  readonly application: ElectronApplication;
  readonly page: Page;
  readonly userData: string;
}

interface RunningRelay {
  readonly child: ChildProcess;
  readonly port: number;
  readonly folder: string;
  readonly certificateFile: string;
}

const instances: Instance[] = [];
const relays: RunningRelay[] = [];
const folders: string[] = [];
const networks: TcpRelay[] = [];

test.afterEach(async () => {
  for (const { application, page } of instances.splice(0)) {
    await closeDiscarding(application, page);
  }
  for (const { child } of relays.splice(0)) {
    child.kill();
  }
  for (const network of networks.splice(0)) {
    network.cut();
    await network.close();
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true, maxRetries: 20 });
  }
});

/** Makes a temporary folder removed after the test. */
async function temporaryFolder(prefix: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}

/** Runs the relay of the repository as its own Node process over TLS on a free port of this computer, as a school would run it without Caddy, or again on the port and folder of a relay that stopped, and waits until it listens. */
async function startRelay(previous?: RunningRelay): Promise<RunningRelay> {
  const folder = previous?.folder ?? (await temporaryFolder('tasklace-e2e-relay-'));
  const tls = await writeRelayCertificate(folder);
  const child = spawn(process.execPath, [RELAY_MAIN], {
    env: {
      PATH: process.env['PATH'] ?? '',
      RELAY_PORT: String(previous?.port ?? 0),
      RELAY_DATA_DIR: folder,
      ...tls,
    },
  });
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const found = RELAY_STARTED.exec(output);
      if (found?.[1] !== undefined) {
        resolve(Number(found[1]));
      }
    });
    child.on('exit', () => {
      reject(new Error(`The relay stopped before listening: ${output}`));
    });
  });
  const relay = { child, port, folder, certificateFile: tls.RELAY_TLS_CERT };
  relays.push(relay);
  return relay;
}

/** Stops a relay as its server would, and waits until its process ended. */
async function stopRelay(relay: RunningRelay): Promise<void> {
  const ended = new Promise((resolve) => relay.child.once('exit', resolve));
  relay.child.kill();
  await ended;
}

/** Launches the application on a user data folder, its own unless one is given, trusting the certificate of the relay of the test, and waits until its interface runs. */
async function launch(relay: RunningRelay, userData?: string): Promise<Instance> {
  const folder = userData ?? (await temporaryFolder('tasklace-e2e-relay-user-'));
  const application = await launchApplication(folder, {
    NODE_EXTRA_CA_CERTS: relay.certificateFile,
  });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
  const instance = { application, page, userData: folder };
  instances.push(instance);
  return instance;
}

/** Closes an instance as a person closes the application, so that it can start again on the same user data folder. */
async function close(instance: Instance): Promise<void> {
  instances.splice(instances.indexOf(instance), 1);
  await closeDiscarding(instance.application, instance.page);
}

/** Creates a plan named Thesis on an instance and shares it through the relay on a port of this computer under a name, giving the two links the clipboard received. */
async function shareThroughRelay(
  { application, page }: Instance,
  port: number,
): Promise<{ readonly editLink: string; readonly viewLink: string }> {
  await page.getByRole('button', { name: /New project/ }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Thesis');
  await page.getByRole('textbox', { name: 'Project name' }).press('Enter');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share “Thesis”' });
  await dialog.getByText(RELAY.throughRelay, { exact: true }).click();
  await dialog.getByLabel(RELAY.address).fill(`wss://${LOOPBACK}:${String(port)}`);
  await dialog.getByLabel('Your name, shown to the others').fill('Camille');
  await dialog.getByRole('button', { name: 'Share the plan' }).click();
  await expect(dialog.locator('.link')).toHaveCount(2);
  await picture(page, 'relay-links');
  /** Copies one of the links from the window and reads what the clipboard received. */
  const copied = async (name: string): Promise<string> => {
    await dialog.getByRole('button', { name }).click();
    return await application.evaluate(({ clipboard }) => clipboard.readText());
  };
  return { editLink: await copied(RELAY.copyEditLink), viewLink: await copied(RELAY.copyViewLink) };
}

/** Joins a plan from an instance by the link pasted, under a name, checking what the window says of the link before joining. */
async function joinByLink(page: Page, link: string, name: string, preview: string): Promise<void> {
  await page.getByRole('button', { name: /^Join…/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Join a shared plan' });
  await dialog.getByLabel(RELAY.linkLabel).fill(link);
  await expect(dialog.getByText(preview)).toBeVisible();
  await dialog.getByLabel('Your name, shown to the others').fill(name);
  await dialog.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Tells whether the vault of the system of an instance protects the links it keeps, which Linux does not without a keyring. */
async function vaultProtects({ application }: Instance): Promise<boolean> {
  return await application.evaluate(({ safeStorage }, unprotected) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return false;
    }
    return (
      process.platform !== 'linux' || !unprotected.includes(safeStorage.getSelectedStorageBackend())
    );
  }, UNPROTECTED_BACKENDS);
}

test('shares a plan through a relay, joined in read only with the link that reads and edited with the link that edits', async () => {
  test.setTimeout(THREE_INSTANCES_TEST_MS);
  const relay = await startRelay();
  const relayLabel = `${LOOPBACK}:${String(relay.port)}`;
  const host = await launch(relay);
  const { editLink, viewLink } = await shareThroughRelay(host, relay.port);
  expect([
    editLink.startsWith(`tasklace://${relayLabel}/#e1.`),
    viewLink.startsWith(`tasklace://${relayLabel}/#v1.`),
  ]).toEqual([true, true]);
  await host.page
    .getByRole('dialog', { name: 'Share “Thesis”' })
    .getByRole('button', { name: 'Done' })
    .click();
  await expect(host.page.getByRole('button', { name: RELAY.shared })).toBeVisible();
  const reader = await launch(relay);
  await joinByLink(
    reader.page,
    viewLink,
    'Léa',
    `Through ${relayLabel} · you will be able to view the plan`,
  );
  await expect(reader.page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Thesis');
  await expect(reader.page.getByRole('button', { name: RELAY.readOnly })).toBeVisible();
  await expect(reader.page.locator('.status-bar .names')).toHaveText('Léa, Camille');
  await picture(reader.page, 'relay-read-only');
  await expect(reader.page.locator('.status-bar .read-only')).toHaveText(
    english.collaboration.readOnlyRight,
  );
  const editor = await launch(relay);
  await joinByLink(
    editor.page,
    editLink,
    'Noah',
    `Through ${relayLabel} · you will be able to edit`,
  );
  await expect(editor.page.getByRole('button', { name: RELAY.shared })).toBeVisible();
  await editor.page.getByRole('textbox', { name: 'Project name' }).fill('Thesis v2');
  await editor.page.getByRole('textbox', { name: 'Project name' }).press('Enter');
  await expect(host.page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Thesis v2');
  await expect(reader.page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Thesis v2');
  await expect(host.page.locator('.status-bar .names')).toHaveText('Camille, Léa, Noah');
});

test('tells the others once new links empty the old place of the plan, the plan staying open', async () => {
  const relay = await startRelay();
  const host = await launch(relay);
  const { viewLink } = await shareThroughRelay(host, relay.port);
  const reader = await launch(relay);
  await joinByLink(
    reader.page,
    viewLink,
    'Léa',
    `Through ${LOOPBACK}:${String(relay.port)} · you will be able to view the plan`,
  );
  const dialog = host.page.getByRole('dialog', { name: 'Share “Thesis”' });
  await dialog.getByText(RELAY.wrongPerson).click();
  await dialog.getByRole('button', { name: RELAY.makeNewLinks }).click();
  await host.page
    .getByRole('dialog', { name: RELAY.newLinksTitle })
    .getByRole('button', { name: RELAY.makeNewLinks })
    .click();
  await expect(dialog.getByText(RELAY.newLinksMade)).toBeVisible();
  await expect(reader.page.getByText(RELAY.ends.CLOSED)).toBeVisible();
  await expect(
    reader.page.getByRole('button', { name: english.collaboration.connectionLost }),
  ).toBeVisible();
  await expect(reader.page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Thesis');
});

test('reopens a plan joined through a relay from the recent projects, coming back to the relay when this computer can keep its link', async () => {
  const relay = await startRelay();
  const relayLabel = `${LOOPBACK}:${String(relay.port)}`;
  const host = await launch(relay);
  const { editLink } = await shareThroughRelay(host, relay.port);
  const guest = await launch(relay);
  await joinByLink(
    guest.page,
    editLink,
    'Noah',
    `Through ${relayLabel} · you will be able to edit`,
  );
  const protects = await vaultProtects(guest);
  if (!protects) {
    await expect(guest.page.getByText(RELAY.linkNotKept)).toBeVisible();
  }
  await close(guest);
  const again = await launch(relay, guest.userData);
  const recent = again.page.getByRole('button', { name: /^Thesis/ });
  await expect(recent).toContainText(`Shared through ${relayLabel}`);
  await recent.click();
  await expect(again.page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Thesis');
  await expect(
    again.page.getByRole(
      'button',
      protects ? { name: RELAY.shared } : { name: 'Share', exact: true },
    ),
  ).toBeVisible();
});

test('keeps the changes made while the relay was down and shares them once it is back', async () => {
  test.setTimeout(RELAY_DOWN_TEST_MS);
  const relay = await startRelay();
  const host = await launch(relay);
  const { editLink } = await shareThroughRelay(host, relay.port);
  await host.page
    .getByRole('dialog', { name: 'Share “Thesis”' })
    .getByRole('button', { name: 'Done' })
    .click();
  const editor = await launch(relay);
  await joinByLink(
    editor.page,
    editLink,
    'Noah',
    `Through ${LOOPBACK}:${String(relay.port)} · you will be able to edit`,
  );
  await expect(editor.page.getByRole('button', { name: RELAY.shared })).toBeVisible();
  await stopRelay(relay);
  const reconnecting = english.collaboration.reconnectingShort;
  await expect(host.page.getByRole('button', { name: reconnecting })).toBeVisible();
  await expect(editor.page.getByRole('button', { name: reconnecting })).toBeVisible();
  await editor.page.getByRole('textbox', { name: 'Project name' }).fill('Thesis offline');
  await editor.page.getByRole('textbox', { name: 'Project name' }).press('Enter');
  await expect(host.page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Thesis');
  await startRelay(relay);
  await expect(host.page.getByRole('textbox', { name: 'Project name' })).toHaveValue(
    'Thesis offline',
  );
  await expect(host.page.getByRole('button', { name: RELAY.shared })).toBeVisible();
  await expect(editor.page.getByRole('button', { name: RELAY.shared })).toBeVisible();
});

test('notices a relay that stops answering without closing anything', async () => {
  test.setTimeout(RELAY_DOWN_TEST_MS);
  const relay = await startRelay();
  const network = await startTcpRelay(() => relay.port);
  networks.push(network);
  const host = await launch(relay);
  await shareThroughRelay(host, network.port);
  await host.page
    .getByRole('dialog', { name: 'Share “Thesis”' })
    .getByRole('button', { name: 'Done' })
    .click();
  await expect(host.page.getByRole('button', { name: RELAY.shared })).toBeVisible();
  network.freeze();
  await expect(
    host.page.getByRole('button', { name: english.collaboration.reconnectingShort }),
  ).toBeVisible({ timeout: RELAY_DOWN_TEST_MS / 2 });
});
