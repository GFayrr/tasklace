import { join } from 'node:path';
import type { Page } from '@playwright/test';

const SCREENSHOT_FOLDER = process.env['TASKLACE_SCREENSHOTS'];

/** Saves a picture of a page under a name when pictures are asked for, to look at the interface, and does nothing otherwise. */
export async function picture(page: Page, name: string): Promise<void> {
  if (SCREENSHOT_FOLDER !== undefined) {
    await page.screenshot({ path: join(SCREENSHOT_FOLDER, `${name}.png`) });
  }
}
