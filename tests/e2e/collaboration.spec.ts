import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscarding, launchApplication } from './application';
import { addTask, taskRow } from './table';

const LOOPBACK = '127.0.0.1';
const SCREENSHOT_FOLDER = process.env['TASKLACE_SCREENSHOTS'];
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const PORT_PATTERN = /port (\d+)/;
const TOOLBAR_WIDTH = 1_280;
const SUCCESSION_LIMIT_MS = 20_000;
const ONE_TOOLBAR_LINE_LIMIT = 80;

interface Instance {
  readonly application: ElectronApplication;
  readonly page: Page;
  readonly userData: string;
}

const instances: Instance[] = [];

test.afterEach(async () => {
  for (const { application, page, userData } of instances.splice(0)) {
    await closeDiscarding(application, page);
    await rm(userData, { recursive: true, force: true });
  }
});

/** Launches the application on a user data folder of its own, so that two instances can run side by side, and waits until its interface runs. */
async function launch(): Promise<Instance> {
  const userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-collaboration-'));
  const application = await launchApplication(userData);
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
  const instance = { application, page, userData };
  instances.push(instance);
  return instance;
}

/** Starts a relay on this computer that carries every connection to a port, which can be cut and opened again on the same port, so that a guest loses the host for a while. */
async function startRelay(target: number) {
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  /** Listens on a port, carrying each connection to the target both ways. */
  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const opened = createServer((incoming) => {
        const outgoing = createConnection(target, LOOPBACK);
        for (const socket of [incoming, outgoing]) {
          sockets.add(socket);
          socket.on('error', () => socket.destroy());
          socket.on('close', () => {
            sockets.delete(socket);
            incoming.destroy();
            outgoing.destroy();
          });
        }
        incoming.pipe(outgoing).pipe(incoming);
      });
      opened.once('error', reject);
      opened.listen(port, LOOPBACK, () => {
        server = opened;
        const address = opened.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  const port = await listen(0);
  return {
    port,
    cut: async (): Promise<void> => {
      const closing = new Promise((resolve) => server?.close(resolve));
      sockets.forEach((socket) => socket.destroy());
      await closing;
    },
    restore: () => listen(port),
  };
}

/** Saves a picture of a window when a folder for pictures is given, to review the interface by eye. */
async function picture(page: Page, name: string): Promise<void> {
  if (SCREENSHOT_FOLDER !== undefined) {
    await page.screenshot({ path: join(SCREENSHOT_FOLDER, `${name}.png`) });
  }
}

/** Joins a plan from an instance the first time, by its address on this computer and its code, under a name. */
async function joinFrom(
  page: Page,
  name: string,
  host: { readonly port: string; readonly code: string },
): Promise<void> {
  await page.getByRole('button', { name: /^Join…/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Join a shared plan' });
  await dialog.getByLabel('Your name, shown to the others').fill(name);
  await dialog.getByText('Join by address').click();
  await dialog.getByLabel('Address of the host').fill(LOOPBACK);
  await dialog.getByLabel('Port').fill(host.port);
  await dialog.getByLabel('Code').fill(host.code);
  await dialog.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Shares a new plan from an instance the first time, giving a name and passing the word about the network, and returns the code and port shown. */
async function shareNewPlan(page: Page): Promise<{ readonly code: string; readonly port: string }> {
  await page.getByRole('button', { name: /New project/ }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share “Untitled project”' });
  await expect(dialog.getByLabel('Your name, shown to the others')).toHaveValue('');
  await picture(page, 'share-first-time');
  await dialog.getByLabel('Your name, shown to the others').fill('Camille');
  await dialog.getByRole('button', { name: 'Share the plan' }).click();
  const note = page.getByRole('dialog', { name: 'Your computer may ask about the network' });
  await expect(note).toBeVisible();
  await picture(page, 'share-firewall');
  await note.getByRole('button', { name: 'Continue' }).click();
  const code = dialog.locator('.code');
  await expect(code).toHaveText(CODE_PATTERN);
  await picture(page, 'share-code');
  const address = (await dialog.locator('.address').textContent()) ?? '';
  return { code: (await code.textContent()) ?? '', port: PORT_PATTERN.exec(address)?.[1] ?? '' };
}

test('shares a plan with a code copied for the others, sharing at once the next time', async () => {
  const { application, page } = await launch();
  const { code } = await shareNewPlan(page);
  const dialog = page.getByRole('dialog', { name: 'Share “Untitled project”' });
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(code);
  await dialog.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.locator('.code')).toHaveText(CODE_PATTERN);
  await expect(page.getByRole('dialog', { name: /may ask about the network/ })).toBeHidden();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Shared, connected' })).toBeVisible();
});

test('joins a plan shared by another instance with its code, in read only, after a wrong code', async () => {
  const host = await launch();
  const { code, port } = await shareNewPlan(host.page);
  const guest = await launch();
  await guest.page.getByRole('button', { name: /^Join…/ }).click();
  const dialog = guest.page.getByRole('dialog', { name: 'Join a shared plan' });
  await dialog.getByLabel('Your name, shown to the others').fill('Léa');
  await dialog.getByText('Join by address').click();
  await dialog.getByLabel('Address of the host').fill(LOOPBACK);
  await dialog.getByLabel('Port').fill(port);
  await dialog.getByLabel('Code').fill(code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
  await dialog.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'This code did not work. Check it with the person who shares it and type it again.',
  );
  await picture(guest.page, 'join-wrong-code');
  await dialog.getByLabel('Code').fill(code.toLowerCase());
  await dialog.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(guest.page.getByRole('textbox', { name: 'Project name' })).toHaveValue(
    'Untitled project',
  );
  const people = host.page
    .getByRole('dialog', { name: 'Share “Untitled project”' })
    .locator('.person');
  await expect(people).toHaveCount(2);
  await expect(people.nth(1)).toContainText('Léa');
  await picture(host.page, 'share-people');
  await guest.page.getByRole('textbox', { name: 'Project name' }).fill('Mine');
  await guest.page.getByRole('textbox', { name: 'Project name' }).press('Enter');
  await expect(
    guest.page.getByText('You are in read only. Camille can let you edit.'),
  ).toBeVisible();
  await expect(guest.page.getByRole('textbox', { name: 'Project name' })).toHaveValue(
    'Untitled project',
  );
  await expect(guest.page.locator('.status-bar .read-only')).toHaveText(
    /Read only\s*Camille can let you edit\./,
  );
});

test('shows where each person is, shares the changes once the host lets a guest edit, and lets the guest host once the host stops', async () => {
  const host = await launch();
  const { code, port } = await shareNewPlan(host.page);
  const shareWindow = host.page.getByRole('dialog', { name: 'Share “Untitled project”' });
  await shareWindow.getByRole('button', { name: 'Done' }).click();
  await addTask(host.page, 'Survey');
  const guest = await launch();
  await joinFrom(guest.page, 'Léa', { port, code });
  await expect(taskRow(guest.page, 'Survey')).toHaveCount(1);
  await taskRow(guest.page, 'Survey').locator('.wbs').click();
  await expect(taskRow(host.page, 'Survey').locator('.presence')).toHaveText('LÉ');
  await taskRow(host.page, 'Survey').locator('.wbs').click();
  await expect(taskRow(guest.page, 'Survey').locator('.presence')).toHaveText('CA');
  await expect(host.page.locator('.status-bar .names')).toHaveText('Camille (host), Léa');
  await host.page.setViewportSize({ width: TOOLBAR_WIDTH, height: 800 });
  const toolbar = await host.page.locator('header.toolbar').boundingBox();
  expect(toolbar?.height).toBeLessThan(ONE_TOOLBAR_LINE_LIMIT);
  await picture(host.page, 'presence-host');
  await picture(guest.page, 'presence-guest');
  await host.page.getByRole('button', { name: 'Shared, connected' }).click();
  await shareWindow
    .getByRole('radiogroup', { name: 'What Léa may do' })
    .getByText('Can edit')
    .click();
  await expect(guest.page.locator('.status-bar .read-only')).toHaveCount(0);
  await guest.page.getByRole('textbox', { name: 'Project name' }).fill('Ours');
  await guest.page.getByRole('textbox', { name: 'Project name' }).press('Enter');
  await expect(host.page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Ours');
  await host.page
    .getByRole('dialog', { name: 'Share “Ours”' })
    .getByRole('button', { name: 'Stop sharing' })
    .click();
  await expect(
    guest.page.getByText('Camille left. You now host the plan; the others join you on their own.'),
  ).toBeVisible({ timeout: SUCCESSION_LIMIT_MS });
  await expect(guest.page.getByRole('button', { name: 'Shared, connected' })).toBeVisible();
  await expect(guest.page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Ours');
  await picture(guest.page, 'new-host');
});

test('lets the oldest guest host once the host stops, the other guest finding it on its own', async () => {
  const camille = await launch();
  const { code, port } = await shareNewPlan(camille.page);
  await camille.page
    .getByRole('dialog', { name: 'Share “Untitled project”' })
    .getByRole('button', { name: 'Done' })
    .click();
  const lea = await launch();
  await joinFrom(lea.page, 'Léa', { port, code });
  const noah = await launch();
  await joinFrom(noah.page, 'Noah', { port, code });
  await expect(camille.page.locator('.status-bar .names')).toHaveText('Camille (host), Léa, Noah');
  await camille.page.getByRole('button', { name: 'Shared, connected' }).click();
  await camille.page
    .getByRole('dialog', { name: 'Share “Untitled project”' })
    .getByRole('button', { name: 'Stop sharing' })
    .click();
  await expect(
    lea.page.getByText('Camille left. You now host the plan; the others join you on their own.'),
  ).toBeVisible({ timeout: SUCCESSION_LIMIT_MS });
  await expect(
    noah.page.getByText('Camille left. Léa now hosts the plan; you are still in.'),
  ).toBeVisible({ timeout: SUCCESSION_LIMIT_MS });
  await expect(lea.page.locator('.status-bar .names')).toHaveText('Léa (host), Noah');
  await addTask(lea.page, 'After the change');
  await expect(taskRow(noah.page, 'After the change')).toHaveCount(1);
  await picture(noah.page, 'host-changed');
});

test('keeps apart the changes a guest in read only made away from the host, then shows the shared plan again', async () => {
  const host = await launch();
  const { code, port } = await shareNewPlan(host.page);
  await host.page
    .getByRole('dialog', { name: 'Share “Untitled project”' })
    .getByRole('button', { name: 'Done' })
    .click();
  await addTask(host.page, 'Survey');
  const relay = await startRelay(Number(port));
  const guest = await launch();
  await joinFrom(guest.page, 'Léa', { port: String(relay.port), code });
  await expect(taskRow(guest.page, 'Survey')).toHaveCount(1);
  await relay.cut();
  await expect(guest.page.locator('.status-bar .badge.reconnecting')).toBeVisible();
  const name = guest.page.getByRole('textbox', { name: 'Project name' });
  await name.fill('Mine');
  await name.press('Enter');
  await expect(name).toHaveValue('Mine');
  await relay.restore();
  const kept = guest.page.getByRole('dialog', { name: 'Your changes stay in your own copy' });
  await expect(kept).toBeVisible({ timeout: SUCCESSION_LIMIT_MS });
  await expect(kept).toContainText('They are kept in a separate plan, “Mine (my changes)”');
  await expect(name).toHaveValue('Untitled project');
  await expect(host.page.getByRole('textbox', { name: 'Project name' })).toHaveValue(
    'Untitled project',
  );
  await picture(guest.page, 'changes-kept');
  await kept.getByRole('button', { name: 'Open my changes' }).click();
  await expect(name).toHaveValue('Mine (my changes)');
  await expect(guest.page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await expect(host.page.locator('.status-bar .names')).toHaveText('Camille (host)');
  await relay.cut();
});
