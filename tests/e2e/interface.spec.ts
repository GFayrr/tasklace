import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { encodeTasklaceFile } from '../../src/core/file/tasklace-file';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { link, project, TEST_DOCUMENT_ID, workTask } from '../../src/core/testing/project-builder';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { closeDiscarding, launchApplication } from './application';
import { addTaskButton } from './table';
import { answerDialogs } from './dialogs';

const SAMPLE = {
  ...project([workTask('a'), workTask('b')], [link('a', 'b')]),
  name: 'Launch plan',
};
const BACKGROUND = 'rgb(247, 246, 243)';
const SCREENSHOT_FOLDER = process.env['TASKLACE_SCREENSHOTS'];
const TOOLBAR_WIDTH = 1_280;
const ONE_TOOLBAR_LINE_LIMIT = 80;

let folder: string;
let userData: string;
let application: ElectronApplication;
let page: Page;
let policyViolations: string[];

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-interface-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await launchApplication(userData);
  page = await application.firstWindow();
  policyViolations = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) {
      policyViolations.push(message.text());
    }
  });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(folder, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
  expect(policyViolations).toEqual([]);
});

/** Saves a picture of the window when a folder for pictures is given, to review the interface by eye. */
async function picture(name: string): Promise<void> {
  if (SCREENSHOT_FOLDER !== undefined) {
    await page.screenshot({ path: join(SCREENSHOT_FOLDER, `${name}.png`) });
  }
}

test('welcomes the user in the light theme, with the embedded Jost font', async () => {
  await expect(page.getByRole('heading', { name: 'Tasklace', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /New project/ })).toBeVisible();
  const look = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      background: getComputedStyle(document.body).backgroundColor,
      jost: document.fonts.check('16px Jost'),
      loaded: [...document.fonts].some(
        (face) => face.family === 'Jost' && face.status === 'loaded',
      ),
    };
  });
  expect(look).toEqual({ background: BACKGROUND, jost: true, loaded: true });
  await picture('welcome');
});

test('creates a project, renames it, and undoes and redoes the change', async () => {
  await page.getByRole('button', { name: /New project/ }).click();
  const name = page.getByRole('textbox', { name: 'Project name' });
  await expect(name).toHaveValue('Untitled project');
  await expect(page.getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText([
    /Deployment/,
    /Design/,
    /Development/,
    /Documentation/,
    /Testing/,
  ]);
  await expect(page.getByText('Kept on this computer only')).toBeVisible();
  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeDisabled();
  await name.fill('Thesis');
  await name.press('Enter');
  await expect(undo).toBeEnabled();
  await page.keyboard.press('Control+z');
  await expect(name).toHaveValue('Untitled project');
  await page.keyboard.press('Control+y');
  await expect(name).toHaveValue('Thesis');
  await name.fill('   ');
  await name.press('Enter');
  await expect(name).toHaveValue('Thesis');
  await picture('project');
});

test('opens a project from the Open menu and shows its schedule', async () => {
  const path = join(folder, 'plan.tasklace');
  await writeFile(
    path,
    encodeTasklaceFile(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID), zlibCompressor),
  );
  await answerDialogs(application, { open: path });
  await page.getByRole('button', { name: /New project/ }).click();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('menuitem', { name: 'Open a file…' }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Launch plan');
  await expect(page.getByText('2 tasks')).toBeVisible();
  await expect(page.getByText(/ – /)).toBeVisible();
  await expect(page.getByText('All changes saved')).toBeVisible();
});

test('keeps the project from changing while another one is being opened', async () => {
  await page.getByRole('button', { name: /New project/ }).click();
  const rows = page.getByRole('grid', { name: 'Tasks' }).getByRole('row');
  const rowsBefore = await rows.count();
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () =>
      new Promise((resolve) => {
        Object.assign(globalThis, {
          cancelOpening: () => {
            resolve({ canceled: true, filePaths: [] });
          },
        });
      });
  });
  await page.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('menuitem', { name: 'Open a file…' }).click();
  const shell = page.locator('.shell');
  await expect(shell).toHaveAttribute('aria-busy', 'true');
  await addTaskButton(page).click({ force: true });
  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(rowsBefore);
  await application.evaluate(() => {
    const cancel: unknown = Reflect.get(globalThis, 'cancelOpening');
    if (typeof cancel === 'function') {
      Reflect.apply(cancel, undefined, []);
    }
  });
  await expect(shell).toHaveAttribute('aria-busy', 'false');
  await expect(rows).toHaveCount(rowsBefore);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await addTaskButton(page).click();
  await expect(rows).toHaveCount(rowsBefore + 1);
});

test('explains why a file cannot be opened, until the message is dismissed', async () => {
  const forged = join(folder, 'forged.tasklace');
  await writeFile(forged, 'not a project at all');
  await answerDialogs(application, { open: forged });
  await page.getByRole('button', { name: /Open…/ }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('This file is not a Tasklace project.');
  await expect(page.getByRole('heading', { name: 'Tasklace', level: 1 })).toBeVisible();
  await picture('error');
  await alert.getByRole('button', { name: 'Dismiss' }).click();
  await expect(alert).toHaveCount(0);
});

test('offers both kinds of import from the welcome screen, and canceling shows nothing', async () => {
  await answerDialogs(application, { open: null });
  await page.getByRole('button', { name: /Import…/ }).click();
  await page.getByRole('button', { name: 'JSON file…' }).click();
  await expect(page.getByRole('heading', { name: 'Tasklace', level: 1 })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('lets messages fade away on their own, but keeps them while the pointer rests on them', async () => {
  const forged = join(folder, 'forged.tasklace');
  await writeFile(forged, 'not a project at all');
  await answerDialogs(application, { open: forged });
  await page.getByRole('button', { name: /Open…/ }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  /** Describes the fading animation of the message: whether it fades, its duration and its state. */
  const fade = () =>
    alert.evaluate((element) => {
      const [animation] = element.getAnimations();
      return animation === undefined
        ? null
        : {
            fades:
              animation instanceof CSSAnimation && animation.animationName.endsWith('notice-fade'),
            duration: animation.effect?.getTiming().duration,
            state: animation.playState,
          };
    });
  await alert.hover();
  await expect.poll(fade).toEqual({ fades: true, duration: 10_000, state: 'paused' });
  await page.mouse.move(0, 0);
  await expect.poll(fade).toEqual({ fades: true, duration: 10_000, state: 'running' });
  await alert.evaluate((element) => {
    for (const animation of element.getAnimations()) {
      animation.finish();
    }
  });
  await expect(alert).toBeHidden();
});

test('changes the calendar in the project settings, each change applied at once and undone after', async () => {
  await page.getByRole('button', { name: /New project/ }).click();
  await page.setViewportSize({ width: TOOLBAR_WIDTH, height: 800 });
  const toolbar = await page.locator('header.toolbar').boundingBox();
  await picture('toolbar-width');
  expect(toolbar?.height).toBeLessThan(ONE_TOOLBAR_LINE_LIMIT);
  await page.getByRole('button', { name: 'Project settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Project settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('tab', { name: 'Calendar' }).click();
  await expect(settings.getByText('9 h per day')).toBeVisible();
  await settings.getByRole('button', { name: 'Add working hours' }).click();
  await expect(settings.getByText('10 h per day')).toBeVisible();
  await settings.getByLabel('End of working hours 2').fill('20:00');
  await expect(settings.getByText('10 h per day')).toBeVisible();
  await settings.getByLabel('End of working hours 2').press('Enter');
  await expect(settings.getByText('11 h per day')).toBeVisible();
  await settings.getByRole('heading', { name: 'Working hours' }).click();
  await page.keyboard.press('Control+z');
  await expect(settings.getByText('10 h per day')).toBeVisible();
  await expect(settings.getByLabel('End of working hours 2')).toHaveValue('19:00');
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
    await settings.getByRole('button', { name: day, exact: true }).click();
  }
  await expect(settings.getByRole('alert')).toHaveText(
    'The calendar needs at least one working day.',
  );
  await expect(settings.getByRole('button', { name: 'Fri', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await picture('project-settings-calendar');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await page.keyboard.press('Control+,');
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(settings).toBeHidden();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.keyboard.press('Control+,');
  await settings.getByRole('tab', { name: 'Calendar' }).click();
  await expect(settings.getByRole('button', { name: 'Thu', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(settings.getByRole('button', { name: 'Wed', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
