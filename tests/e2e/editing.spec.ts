import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { closeDiscarding, launchApplication } from './application';

import { paleColor } from '../../src/renderer/plan/tag-styles';
import { pixelsPerHour } from '../../src/renderer/plan/time-scale';
import { ROW_HEIGHT } from '../../src/renderer/plan/timeline-geometry';
import { SAND_GRAPHITE } from '../../src/renderer/theme/sand-graphite';

const SCREENSHOT_FOLDER = process.env['TASKLACE_SCREENSHOTS'];
const HOURS_PER_DAY = 24;
const DAY_WIDTH = HOURS_PER_DAY * pixelsPerHour('day');
const DAYS_DRAGGED = 3;
const HALF = 0.5;

let userData: string;
let application: ElectronApplication;
let page: Page;
let grid: Locator;
let today: Date;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await launchApplication(userData);
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
  await page.getByRole('button', { name: /New project/ }).click();
  today = new Date(await page.evaluate(() => Date.now()));
  grid = page.getByRole('grid', { name: 'Tasks' });
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(userData, { recursive: true, force: true });
});

/** Returns the hours a new one-day task works once its end is stretched by some calendar days, under the default calendar of 9 hours from Monday to Friday, counted from the day the application created the project so that the test does not depend on the day it runs. */
function stretchedHours(days: number): number {
  const day = new Date(today);
  while (day.getDay() === 0 || day.getDay() === 6) {
    day.setDate(day.getDate() + 1);
  }
  let workingDays = 1;
  for (let added = 1; added <= days; added += 1) {
    day.setDate(day.getDate() + 1);
    workingDays += day.getDay() === 0 || day.getDay() === 6 ? 0 : 1;
  }
  return workingDays * 9;
}

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
  await expect(editor).toHaveValue('New task');
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
  await typeInCell('Second', 2, '3d');
  await expect(row('Second')).toContainText('27 h');
  await page.getByRole('button', { name: 'Hour', exact: true }).click();
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  const scroller = page.locator('.timeline .scroller');
  const box = await scroller.boundingBox();
  if (box === null) {
    throw new Error('No timeline');
  }
  const barCentre = async (index: number) => {
    const spans = await blockSpans(index);
    return { start: spans[0]?.start ?? 0, end: spans.at(-1)?.end ?? 0 };
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
  await page.mouse.move(box.x + first.end + 96, y(0), { steps: 5 });
  await page.mouse.up();
  await expect(row('First')).toContainText(`${String(stretchedHours(3))} h`);
  await expect.poll(async () => (await barCentre(0)).end).toBeGreaterThan(first.end + 10);

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

test('manages tags in the settings, lists the conflicts of a person, and deletes a tag after asking', async () => {
  await addTask('Interviews');
  await addTask('Analysis');
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Project settings' });
  await settings.getByRole('tab', { name: 'Tags' }).click();
  await settings.getByRole('button', { name: 'Add a tag' }).click();
  const name = settings.getByLabel('Name of “New tag”');
  await expect(name).toBeFocused();
  await name.fill('Alice');
  await name.press('Enter');
  await settings.getByLabel('“Alice” represents a person or team').check();
  await picture('tag-settings');
  await settings.getByRole('button', { name: 'Done' }).click();
  for (const task of ['Interviews', 'Analysis']) {
    await row(task).getByRole('gridcell').nth(7).dblclick();
    await page.getByRole('listbox').getByRole('option', { name: 'Alice' }).click();
    await expect(row(task)).toContainText('Alice');
  }

  await page.getByRole('button', { name: '1 conflict' }).click();
  const list = page.getByRole('region', { name: 'Conflicts' });
  await expect(list).toContainText('Alice');
  await expect(list).toContainText('Interviews');
  await picture('tag-conflicts');
  await list.getByRole('button', { name: /Alice/ }).click();
  await expect(grid.getByRole('row', { selected: true })).toContainText(/Interviews|Analysis/);

  await page.keyboard.press('Control+,');
  await settings.getByRole('tab', { name: 'Tags' }).click();
  await settings.getByRole('button', { name: 'Delete the tag “Alice”' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete the tag “Alice”?' });
  await expect(confirm).toContainText('2 tasks use it.');
  await confirm.getByRole('button', { name: 'Delete the tag' }).click();
  await expect(settings.getByLabel('Name of “Alice”')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0);
  await expect(row('Analysis')).not.toContainText('Alice');
  await page.keyboard.press('Control+z');
  await expect(settings.getByLabel('Name of “Alice”')).toHaveValue('Alice');
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(row('Analysis')).toContainText('Alice');
  await expect(page.getByRole('button', { name: '1 conflict' })).toBeVisible();
});

test('shows the critical path and the floats once turned on in the advanced options, and undoes it', async () => {
  await addTask('Review');
  await addTask('Write');
  await typeInCell('Write', 6, '1');
  await addTask('Figures');
  await typeInCell('Figures', 2, '2');
  await expect(grid.getByRole('columnheader', { name: 'Total float' })).toHaveCount(0);
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Project settings' });
  await settings.getByRole('tab', { name: 'Advanced options' }).click();
  const critical = settings.getByRole('switch', { name: 'Critical path' });
  await critical.click();
  await expect(critical).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByRole('switch', { name: 'Baseline' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await picture('advanced-options');
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(grid.getByRole('columnheader', { name: 'Total float' })).toBeVisible();
  await expect(grid.getByRole('columnheader', { name: 'Free float' })).toBeVisible();
  await expect(row('Write').locator('.name')).toHaveClass(/critical/);
  await expect(row('Figures').locator('.name')).not.toHaveClass(/critical/);
  await expect(row('Figures').locator('.float').first()).toHaveText(/\d+ h/);
  await expect(
    page.getByText('Critical: delaying these tasks delays the end of the project'),
  ).toBeVisible();
  await picture('critical-path');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(grid.getByRole('columnheader', { name: 'Total float' })).toHaveCount(0);
});

/** Writes a local working day, about some days away from the day the application created the project and moved forward past a weekend, as an ISO date and time. */
function isoDaysFromToday(days: number, time: string): string {
  const moment = new Date(today);
  moment.setDate(moment.getDate() + days);
  while (moment.getDay() === 0 || moment.getDay() === 6) {
    moment.setDate(moment.getDate() + 1);
  }
  const month = String(moment.getMonth() + 1).padStart(2, '0');
  const day = String(moment.getDate()).padStart(2, '0');
  return `${String(moment.getFullYear())}-${month}-${day} ${time}`;
}

test('works to the quarter hour and moves the project start for an earlier task', async () => {
  await addTask('Meeting');
  await typeInCell('Meeting', 2, '1h30');
  await expect(row('Meeting')).toContainText('1 h 30');
  await typeInCell('Meeting', 3, isoDaysFromToday(1, '10:15'));
  await expect(row('Meeting').getByRole('gridcell').nth(3)).toHaveText(
    isoDaysFromToday(1, '10:15'),
  );
  await expect(row('Meeting').getByRole('gridcell').nth(4)).toHaveText(
    isoDaysFromToday(1, '11:45'),
  );
  await typeInCell('Meeting', 4, isoDaysFromToday(1, '12:00'));
  await expect(row('Meeting')).toContainText('1 h 45');
  await typeInCell('Meeting', 3, isoDaysFromToday(-10, '09:00'));
  await expect(
    page.getByRole('status').filter({ hasText: 'The project now starts on' }),
  ).toBeVisible();
  await expect(row('Meeting').getByRole('gridcell').nth(3)).toHaveText(
    isoDaysFromToday(-10, '09:00'),
  );
  await page.keyboard.press('Control+z');
  await expect(row('Meeting').getByRole('gridcell').nth(3)).toHaveText(
    isoDaysFromToday(1, '10:15'),
  );
});

test('chooses a start on the calendar of the system, to the quarter hour', async () => {
  await addTask('Review');
  const button = row('Review').getByRole('button', {
    name: 'Choose the start of Review on a calendar',
  });
  await row('Review').hover();
  await button.click();
  await page.evaluate(
    (value) => {
      const picker = document.querySelector<HTMLInputElement>('input.picker');
      if (picker !== null) {
        picker.value = value;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    isoDaysFromToday(2, '14:05').replace(' ', 'T'),
  );
  await expect(row('Review').getByRole('gridcell').nth(3)).toHaveText(isoDaysFromToday(2, '14:00'));
});

test('makes a block of a split task wait for another task, shown in its details only', async () => {
  await addTask('Brief');
  await addTask('Build');
  await row('Build').getByRole('gridcell').nth(1).click();
  await page.keyboard.press('Alt+Enter');
  const details = page.getByRole('dialog', { name: 'Task details' });
  await details.getByRole('button', { name: 'Add a block' }).click();
  await details.getByRole('textbox', { name: 'Days after block 1' }).fill('0');
  const waits = details.getByRole('textbox', { name: 'Block 2 waits for' });
  await waits.fill('9');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details.getByRole('alert')).toContainText('There is no task with this number');
  await waits.fill('1#2');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details.getByRole('alert')).toContainText('no block with this number');
  await waits.fill('1');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details).toBeHidden();
  await expect(row('Build').getByRole('gridcell').nth(6)).toHaveText('');

  await page.keyboard.press('Alt+Enter');
  await expect(waits).toHaveValue('1');
  await details.getByRole('button', { name: 'Remove block 1' }).click();
  await expect(waits).toHaveCount(0);
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details).toBeHidden();
  await expect(row('Build').getByRole('gridcell').nth(6)).toHaveText('1');
});

test('starts a later block no earlier than a date chosen in the details', async () => {
  await addTask('Build');
  await row('Build').getByRole('gridcell').nth(1).click();
  await page.keyboard.press('Alt+Enter');
  const details = page.getByRole('dialog', { name: 'Task details' });
  await details.getByRole('button', { name: 'Add a block' }).click();
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details).toBeHidden();
  const endBefore = await row('Build').getByRole('gridcell').nth(4).textContent();
  await page.keyboard.press('Alt+Enter');
  const start = details.getByLabel('Block 2 starts no earlier than');
  await start.fill(isoDaysFromToday(8, '14:00').replace(' ', 'T'));
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details).toBeHidden();
  await expect(row('Build').getByRole('gridcell').nth(4)).not.toHaveText(endBefore ?? '');
  await expect(row('Build').getByRole('gridcell').nth(4)).toHaveText(
    /^\s*\d{4}-\d{2}-\d{2} 14:00\s*$/,
  );
  await page.keyboard.press('Alt+Enter');
  await expect(start).toHaveValue(isoDaysFromToday(8, '14:00').replace(' ', 'T'));
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
});

test('tags a task from the table and splits it into blocks in its details', async () => {
  await addTask('Write');
  await row('Write').getByRole('gridcell').nth(7).dblclick();
  await page.getByRole('listbox').getByRole('option', { name: 'Testing' }).click();
  await expect(row('Write')).toContainText('Testing');
  await row('Write').getByRole('gridcell').nth(7).dblclick();
  await expect(page.getByRole('listbox')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(row('Write')).toContainText('Design');
  await row('Write').getByRole('gridcell').nth(7).dblclick();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(row('Write')).toContainText('Design');

  await row('Write').getByRole('gridcell').nth(1).click();
  await page.getByRole('button', { name: 'Details of the task' }).click();
  const details = page.getByRole('dialog', { name: 'Task details' });
  await expect(details).toBeVisible();
  await details.getByRole('textbox', { name: 'Duration of block 1' }).fill('4 h');
  await details.getByRole('button', { name: 'Add a block' }).click();
  await details.getByRole('textbox', { name: 'Days after block 1' }).fill('half');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details.getByRole('alert')).toContainText('0 for the same day');
  await details.getByRole('textbox', { name: 'Days after block 1' }).fill('2');
  await details.getByRole('textbox', { name: 'Duration of block 2' }).fill('1 h 30');
  await picture('details');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details).toBeHidden();
  await expect(row('Write')).toContainText('5 h 30');
  await page.keyboard.press('Control+z');
  await expect(row('Write')).toContainText('9 h');

  await row('Write').getByRole('gridcell').nth(1).click();
  await page.keyboard.press('Alt+Enter');
  await expect(details).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
});

/** Returns the numbers the table shows, from top to bottom, with the task name of each row. */
async function outlineTexts(): Promise<string[]> {
  const rows = grid.locator('.body [role="row"]:not(.add-row)');
  const texts: string[] = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const cells = rows.nth(index).getByRole('gridcell');
    texts.push(
      `${(await cells.nth(0).innerText()).trim()} ${(await cells.nth(1).innerText()).trim()}`,
    );
  }
  return texts;
}

test('indents, outdents, reorders and folds tasks from the keyboard', async () => {
  await addTask('Parent');
  await addTask('Child');
  await addTask('Other');
  await row('Child').getByRole('gridcell').first().click();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect.poll(outlineTexts).toEqual(['1 Parent', '1.1 Child', '2 Other']);
  await row('Parent').getByRole('gridcell').first().click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(outlineTexts).toEqual(['1 Parent', '2 Other']);
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(outlineTexts).toEqual(['1 Parent', '1.1 Child', '2 Other']);
  await row('Child').getByRole('gridcell').first().click();
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await expect.poll(outlineTexts).toEqual(['1 Parent', '2 Child', '3 Other']);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(outlineTexts).toEqual(['1 Child', '2 Parent', '3 Other']);
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(outlineTexts).toEqual(['1 Parent', '2 Child', '3 Other']);
});

/** Finds the blocks drawn in a row of the timeline by the pale color of untagged bars, from left to right, failing when the row shows none. */
async function blockSpans(rowIndex: number): Promise<{ start: number; end: number }[]> {
  const pale = paleColor(SAND_GRAPHITE.bar);
  const color = [1, 3, 5].map((offset) => Number.parseInt(pale.slice(offset, offset + 2), 16));
  const spans = await page.evaluate(
    ({ row: wanted, rgb }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.timeline .layer');
      const context = canvas?.getContext('2d');
      if (canvas === null || context === null || context === undefined) {
        return [];
      }
      const density = window.devicePixelRatio || 1;
      const y = Math.round((wanted * 34 + 17) * density);
      const { data } = context.getImageData(0, y, canvas.width, 1);
      const found: { start: number; end: number }[] = [];
      for (let x = 0; x < canvas.width; x += 1) {
        const [red = 0, green = 0, blue = 0] = data.slice(x * 4, x * 4 + 3);
        const [wantedRed = 0, wantedGreen = 0, wantedBlue = 0] = rgb;
        const matches =
          Math.abs(red - wantedRed) < 4 &&
          Math.abs(green - wantedGreen) < 4 &&
          Math.abs(blue - wantedBlue) < 4;
        const last = found.at(-1);
        if (matches && last !== undefined && x / density - last.end <= 3) {
          last.end = x / density;
        } else if (matches) {
          found.push({ start: x / density, end: x / density });
        }
      }
      return found;
    },
    { row: rowIndex, rgb: color },
  );
  if (spans.length === 0) {
    throw new Error(`No bar in row ${String(rowIndex)}`);
  }
  return spans;
}

test('moves a later block of a split task alone, giving it the start where it was dropped', async () => {
  await addTask('Split');
  await row('Split').getByRole('gridcell').first().click();
  await page.keyboard.press('Alt+Enter');
  const details = page.getByRole('dialog', { name: 'Task details' });
  await details.getByRole('button', { name: 'Add a block' }).click();
  await details.getByRole('textbox', { name: 'Days after block 1' }).fill('0');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details).toBeHidden();
  const scroller = page.locator('.timeline .scroller');
  const box = await scroller.boundingBox();
  if (box === null) {
    throw new Error('No timeline');
  }
  await expect.poll(async () => (await blockSpans(0)).length).toBe(2);
  const [first, second] = await blockSpans(0);
  if (first === undefined || second === undefined) {
    throw new Error('Missing blocks');
  }
  const middle = box.y + ROW_HEIGHT / 2;
  await page.mouse.move(box.x + (second.start + second.end) / 2, middle);
  await page.mouse.down();
  const dragged = DAYS_DRAGGED * DAY_WIDTH;
  await page.mouse.move(box.x + (second.start + second.end) / 2 + dragged, middle, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await blockSpans(0))[1]?.start ?? 0)
    .toBeGreaterThanOrEqual(second.start + dragged - HALF * DAY_WIDTH);
  const [kept] = await blockSpans(0);
  expect(kept?.start).toBeCloseTo(first.start, 0);
  expect(kept?.end).toBeCloseTo(first.end, 0);
  await page.getByRole('button', { name: 'Details of the task' }).click();
  await expect(details.getByLabel('Block 2 starts no earlier than')).not.toHaveValue('');
});
