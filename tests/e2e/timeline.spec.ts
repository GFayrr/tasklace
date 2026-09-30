import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { encodeTasklaceFile } from '../../src/core/file/tasklace-file';
import type { Project, Tag } from '../../src/core/model/project';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import {
  link,
  milestone,
  project,
  splitTask,
  summary,
  TEST_DOCUMENT_ID,
  workTask,
} from '../../src/core/testing/project-builder';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { buildLargeProject } from '../fixtures/large-project';
import { answerDialogs } from './dialogs';

const SCREENSHOT_FOLDER = process.env['TASKLACE_SCREENSHOTS'];
const DESIGN: Tag = {
  id: 'design',
  name: 'Design',
  color: '#2a78d6',
  representsPersonOrTeam: false,
};
const BUILD: Tag = {
  id: 'build',
  name: 'Development',
  color: '#eb6834',
  representsPersonOrTeam: false,
};
const ALEX: Tag = { id: 'alex', name: 'Alex', color: '#1baf7a', representsPersonOrTeam: true };
const SAMPLE: Project = {
  ...project(
    [
      summary('design', { name: 'Design', sortKey: 'a' }),
      workTask('research', {
        name: 'User research',
        parentId: 'design',
        sortKey: 'a',
        tagId: 'design',
        progressPercent: 100,
        segments: [{ durationHours: 21, gapDaysBefore: 0 }],
      }),
      splitTask(
        'wireframes',
        [
          [14, 0],
          [14, 3],
        ],
        {
          name: 'Wireframes',
          parentId: 'design',
          sortKey: 'b',
          tagId: 'design',
          progressPercent: 60,
        },
      ),
      milestone('approved', { name: 'Mockups approved', parentId: 'design', sortKey: 'c' }),
      summary('build', { name: 'Development', sortKey: 'b' }),
      workTask('front', {
        name: 'Front-end',
        parentId: 'build',
        sortKey: 'a',
        tagId: 'alex',
        progressPercent: 20,
        segments: [{ durationHours: 35, gapDaysBefore: 0 }],
      }),
      workTask('back', {
        name: 'Back-end',
        parentId: 'build',
        sortKey: 'b',
        tagId: 'alex',
        segments: [{ durationHours: 28, gapDaysBefore: 0 }],
      }),
      workTask('integration', {
        name: 'Integration',
        parentId: 'build',
        sortKey: 'c',
        tagId: 'build',
        segments: [{ durationHours: 14, gapDaysBefore: 0 }],
      }),
      milestone('launch', { name: 'Launch', sortKey: 'c' }),
    ],
    [
      link('research', 'wireframes'),
      link('wireframes', 'approved'),
      link('approved', 'front'),
      link('front', 'back', 'startToStart'),
      link('front', 'integration'),
      link('back', 'integration', 'finishToFinish'),
      link('integration', 'launch'),
    ],
    { tags: [DESIGN, BUILD, ALEX] },
  ),
  name: 'Website redesign',
};

let folder: string;
let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-timeline-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] });
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
});

test.afterEach(async () => {
  await application.close();
  await rm(folder, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

/** Writes a project as a file and opens it through the Open dialog. */
async function openProject(plan: Project): Promise<void> {
  const path = join(folder, 'plan.tasklace');
  await writeFile(
    path,
    encodeTasklaceFile(createSharedDocument(plan, TEST_DOCUMENT_ID), zlibCompressor),
  );
  await answerDialogs(application, { open: path });
  await page.getByRole('button', { name: /Open…/ }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(plan.name);
}

/** Saves a picture of the window when a folder for pictures is given, to review the interface by eye. */
async function picture(name: string): Promise<void> {
  if (SCREENSHOT_FOLDER !== undefined) {
    await page.screenshot({ path: join(SCREENSHOT_FOLDER, `${name}.png`) });
  }
}

/** Counts the pixels of the timeline canvas that differ from its background. */
async function paintedPixels(): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.timeline .layer');
    const context = canvas?.getContext('2d');
    if (canvas === null || context === null || context === undefined) {
      return 0;
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] !== 255 || data[index + 1] !== 255 || data[index + 2] !== 255) {
        painted += 1;
      }
    }
    return painted;
  });
}

test('shows the task table and draws the timeline of a project', async () => {
  await openProject(SAMPLE);
  const table = page.getByRole('table', { name: 'Tasks' });
  await expect(table.getByRole('row')).toHaveCount(10);
  await expect(table.getByRole('row').nth(3)).toContainText('1.2');
  await expect(table.getByRole('row').nth(3)).toContainText('Wireframes');
  await expect(table.getByRole('row').nth(3)).toContainText('28 h');
  await expect(table.getByRole('row').nth(3)).toContainText('60%');
  await expect(table.getByRole('row').nth(7)).toContainText('2.1SS');
  await expect.poll(paintedPixels).toBeGreaterThan(1_000);
  await picture('timeline-day');
  for (const zoom of ['Hour', 'Week', 'Month']) {
    await page.getByRole('button', { name: zoom, exact: true }).click();
    await expect(page.getByRole('button', { name: zoom, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await picture(`timeline-${zoom.toLowerCase()}`);
  }
});

test('collapses a summary and selects a task in both panes', async () => {
  await openProject(SAMPLE);
  const table = page.getByRole('table', { name: 'Tasks' });
  await page.getByRole('button', { name: 'Collapse Design' }).click();
  await expect(table.getByRole('row')).toHaveCount(7);
  await page.getByRole('button', { name: 'Expand Design' }).click();
  await expect(table.getByRole('row')).toHaveCount(10);
  await table.getByRole('row', { name: /Front-end/ }).click();
  await expect(table.getByRole('row', { name: /Front-end/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('remembers the width of the task table', async () => {
  await openProject(SAMPLE);
  const separator = page.getByRole('separator', { name: 'Width of the task table' });
  const before = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(before + 32));
  const stored = await page.evaluate(() => localStorage.getItem('tasklace.taskTableWidth'));
  expect(stored).toBe(String(before + 32));
});

test('draws only the visible rows of a project of 10,000 tasks', async () => {
  const large = { ...buildLargeProject(), name: 'Large plan' };
  await openProject(large);
  const table = page.getByRole('table', { name: 'Tasks' });
  await expect(table).toHaveAttribute('aria-rowcount', '10001');
  const shown = await table.getByRole('row').count();
  expect(shown).toBeLessThan(60);
  await expect.poll(paintedPixels).toBeGreaterThan(1_000);
  const frames = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.timeline .scroller');
    if (scroller === null) {
      return [];
    }
    const durations: number[] = [];
    let last = performance.now();
    for (let step = 0; step < 60; step += 1) {
      scroller.scrollTop += 400;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      durations.push(now - last);
      last = now;
    }
    return durations.sort((left, right) => left - right);
  });
  await picture('timeline-large');
  const median = frames[Math.floor(frames.length / 2)] ?? Number.POSITIVE_INFINITY;
  console.info(`Median frame while scrolling 10,000 tasks: ${median.toFixed(1)} ms`);
  expect(median).toBeLessThan(1_000 / 30);
});
