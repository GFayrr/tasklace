import { expect, type Locator, type Page } from '@playwright/test';

/** Returns the task table of the window. */
export function taskGrid(page: Page): Locator {
  return page.getByRole('grid', { name: 'Tasks' });
}

/** Adds a task with the toolbar and types its name. */
export async function addTask(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add task' }).click();
  const editor = taskGrid(page).getByRole('textbox');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('New task');
  await editor.fill(name);
  await editor.press('Enter');
}

/** Returns a row of the table by the task name it shows. */
export function taskRow(page: Page, name: string): Locator {
  return taskGrid(page).getByRole('row').filter({ hasText: name });
}

/** Types a text in a cell of the row of a task, by the index of its column, and validates it. */
export async function typeInCell(
  page: Page,
  name: string,
  column: number,
  text: string,
): Promise<void> {
  await taskRow(page, name).getByRole('gridcell').nth(column).dblclick();
  const editor = taskGrid(page).getByRole('textbox');
  await editor.fill(text);
  await editor.press('Enter');
}

/** Returns the texts of the cells of every task row the table shows, without the header and the row that adds a task. */
export async function tableTexts(page: Page): Promise<string[][]> {
  const rows = taskGrid(page).getByRole('row');
  const count = await rows.count();
  const texts: string[][] = [];
  for (let index = 1; index < count; index += 1) {
    const cells = await rows.nth(index).getByRole('gridcell').allInnerTexts();
    if (cells.length > 1) {
      texts.push(cells.map((text) => text.trim()));
    }
  }
  return texts;
}
