import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscarding, launchApplication } from './application';

let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-settings-'));
  await launch();
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(userData, { recursive: true, force: true });
});

/** Launches the application on the user data folder of the test and waits until its interface runs. */
async function launch(): Promise<void> {
  application = await launchApplication(userData);
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
}

/** Writes the day of a moment in the time zone of this computer, as the main process notes the day of a check. */
function localDay(moment: Date): string {
  const month = String(moment.getMonth() + 1).padStart(2, '0');
  return `${String(moment.getFullYear())}-${month}-${String(moment.getDate()).padStart(2, '0')}`;
}

/** Makes the main process answer the next requests for releases with a body, or fail to reach GitHub, instead of asking GitHub. */
async function answerReleasesWith(body: string | null): Promise<void> {
  await application.evaluate(({ net }, answer) => {
    net.fetch = () =>
      answer === null
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(new Response(answer));
  }, body);
}

test('shows the version and keeps the choice about new versions on this computer, across a restart', async () => {
  const version = await application.evaluate(({ app }) => app.getVersion());
  await expect(page.locator('.welcome .footer')).toHaveText(
    new RegExp(`^\\s*Tasklace ${version.replaceAll('.', '\\.')}\\s*Tasklace settings\\s*$`),
  );
  await page.getByRole('button', { name: 'Tasklace settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Tasklace settings' });
  const check = settings.getByRole('switch', { name: 'Check for new versions' });
  await expect(check).toHaveAttribute('aria-checked', 'true');
  await check.click();
  await expect(check).toHaveAttribute('aria-checked', 'false');
  await expect(settings.getByRole('status')).toHaveText(
    'Tasklace does not check for new versions. You can still use “Check now”.',
  );
  expect(JSON.parse(await readFile(join(userData, 'update-check.json'), 'utf8'))).toEqual({
    version: 1,
    settings: { checkForNewVersions: false, lastCheckedOn: null },
  });
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(settings).toBeHidden();
  await closeDiscarding(application, page);
  await launch();
  await page.getByRole('button', { name: 'Tasklace settings' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Tasklace settings' })
      .getByRole('switch', { name: 'Check for new versions' }),
  ).toHaveAttribute('aria-checked', 'false');
});

test('checks now from the menu of the toolbar, telling of a newer version, then of a check that could not run', async () => {
  await page.getByRole('button', { name: /New project/ }).click();
  await page.getByRole('button', { name: 'Tasklace', exact: true }).click();
  await page.getByRole('menuitem', { name: /Tasklace settings…/ }).click();
  const settings = page.getByRole('dialog', { name: 'Tasklace settings' });
  const before = localDay(new Date());
  await answerReleasesWith(
    JSON.stringify([{ tag_name: 'v99.0.0', draft: false, prerelease: false }]),
  );
  await settings.getByRole('button', { name: 'Check now' }).click();
  await expect(settings.getByRole('status')).toHaveText(
    /Tasklace 99\.0\.0 is available\.\s*Open the release page/,
  );
  await answerReleasesWith(null);
  await settings.getByRole('button', { name: 'Check now' }).click();
  await expect(settings.getByRole('status')).toHaveText(
    'Tasklace could not find out which version is the latest. Try again later.',
  );
  const stored: unknown = JSON.parse(await readFile(join(userData, 'update-check.json'), 'utf8'));
  const after = localDay(new Date());
  expect([before, after]).toContain(
    Reflect.get(Object(Reflect.get(Object(stored), 'settings')), 'lastCheckedOn'),
  );
  expect(stored).toEqual({
    version: 1,
    settings: {
      checkForNewVersions: true,
      lastCheckedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    },
  });
});
