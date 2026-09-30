import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

import { paleColor } from '../../src/renderer/plan/tag-styles';
import { SAND_GRAPHITE } from '../../src/renderer/theme/sand-graphite';

const SCREENSHOT_FOLDER = process.env['TASKLACE_SCREENSHOTS'];
const ROW_HEIGHT = 34;

let userData: string;
let application: ElectronApplication;
let page: Page;
let grid: Locator;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] });
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
  await page.getByRole('button', { name: /New project/ }).click();
  grid = page.getByRole('grid', { name: 'Tasks' });
});

test.afterEach(async () => {
  await application.close();
  await rm(userData, { recursive: true, force: true });
});

/** Saves a picture of the window when a folder for pictures is given, to review the interface by eye. */
async function picture(name: string): Promise<void> {
  if (SCREENSHOT_FOLDER !== undefined) {
    await page.screenshot({ path: join(SCREENSHOT_FOLDER, `${name}.png`) });
  }
}

/** Adds a task with the toolbar and types its name. */
async function addTask(name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add task' }).click();
  const editor = grid.getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.fill(name);
  await editor.press('Enter');
}

/** Returns a row of the table by the task name it shows. */
function row(name: string): Locator {
  return grid.getByRole('row').filter({ hasText: name });
}

/** Returns the edited text of a cell, typed after pressing a column's key sequence. */
async function typeInCell(name: string, column: number, text: string): Promise<void> {
  await row(name).getByRole('gridcell').nth(column).dblclick();
  const editor = grid.getByRole('textbox');
  await editor.fill(text);
  await editor.press('Enter');
}

test('plans tasks from the keyboard and the table, and undoes each change', async () => {
  await addTask('Research');
  await addTask('Design');
  await addTask('Build');
  await expect(row('Research')).toContainText('1');
  await typeInCell('Research', 2, '2d');
  await expect(row('Research')).toContainText('18 h');
  await typeInCell('Design', 6, '1');
  await typeInCell('Build', 6, '2FS+3h');
  await expect(row('Build')).toContainText('2FS+3h');
  await typeInCell('Design', 5, '40');
  await expect(row('Design')).toContainText('40%');
  await typeInCell('Design', 2, 'soon');
  await expect(page.getByRole('alert')).toContainText('Write the duration in hours');
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
  await typeInCell('Research', 6, '3');
  await expect(page.getByRole('alert')).toContainText('loop');
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
  await picture('editing-table');

  await row('Build').getByRole('gridcell').nth(1).click();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(row('Design')).toContainText('2');
  await expect(row('Build')).toContainText('2.1');
  await expect(row('Design')).not.toContainText('40%');
  await page.keyboard.press('Control+z');
  await expect(row('Build')).toContainText('3');
  await expect(row('Design')).toContainText('40%');

  await row('Research').getByRole('gridcell').nth(1).click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(grid.getByRole('row').nth(1)).toContainText('Design');
  await page.keyboard.press('Delete');
  await expect(row('Research')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(row('Research')).toHaveCount(1);
});

test('moves, stretches and links bars on the timeline', async () => {
  await addTask('First');
  await addTask('Second');
  await page.getByRole('button', { name: 'Hour', exact: true }).click();
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  const scroller = page.locator('.timeline .scroller');
  const box = await scroller.boundingBox();
  if (box === null) {
    throw new Error('No timeline');
  }
  const pale = paleColor(SAND_GRAPHITE.bar);
  const channels = [1, 3, 5].map((offset) => Number.parseInt(pale.slice(offset, offset + 2), 16));
  const barCentre = async (index: number) => {
    const found = await page.evaluate(
      ({ rowIndex, color }) => {
        const canvas = document.querySelector<HTMLCanvasElement>('.timeline .layer');
        if (canvas === null) {
          return null;
        }
        const context = canvas.getContext('2d');
        if (context === null) {
          return null;
        }
        const density = window.devicePixelRatio || 1;
        const y = Math.round((rowIndex * 34 + 17) * density);
        const { data } = context.getImageData(0, y, canvas.width, 1);
        const xs: number[] = [];
        for (let x = 0; x < canvas.width; x += 1) {
          const [red = 0, green = 0, blue = 0] = data.slice(x * 4, x * 4 + 3);
          const [wantedRed = 0, wantedGreen = 0, wantedBlue = 0] = color;
          if (
            Math.abs(red - wantedRed) < 4 &&
            Math.abs(green - wantedGreen) < 4 &&
            Math.abs(blue - wantedBlue) < 4
          ) {
            xs.push(x / density);
          }
        }
        return xs.length === 0 ? null : { start: Math.min(...xs), end: Math.max(...xs) };
      },
      { rowIndex: index, color: channels },
    );
    if (found === null) {
      throw new Error(`No bar in row ${String(index)}`);
    }
    return found;
  };
  const first = await barCentre(0);
  const second = await barCentre(1);
  const y = (index: number) => box.y + index * ROW_HEIGHT + ROW_HEIGHT / 2;

  await page.mouse.move(box.x + (second.start + second.end) / 2, y(1));
  await page.mouse.down();
  await page.mouse.move(box.x + (second.start + second.end) / 2 + 96, y(1), { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await barCentre(1)).start).toBeGreaterThan(second.start + 60);

  await page.mouse.move(box.x + first.end - 1, y(0));
  await page.mouse.down();
  await page.mouse.move(box.x + first.end + 64, y(0), { steps: 5 });
  await page.mouse.up();
  await expect(row('First')).toContainText('27 h');
  await expect.poll(async () => (await barCentre(0)).end).toBeGreaterThan(first.end + 40);

  const stretched = await barCentre(0);
  await page.mouse.click(box.x + (stretched.start + stretched.end) / 2, y(0));
  await page.mouse.move(box.x + stretched.end + 12, y(0));
  await page.mouse.down();
  const moved = await barCentre(1);
  await page.mouse.move(box.x + (moved.start + moved.end) / 2, y(1), { steps: 5 });
  await page.mouse.up();
  await expect(grid.getByRole('row').nth(2).getByRole('gridcell').nth(6)).toHaveText('1');
  await picture('editing-timeline');
});
