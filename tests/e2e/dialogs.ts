import type { ElectronApplication, Page } from '@playwright/test';

export interface ChosenPaths {
  readonly open?: string | null;
  readonly save?: string | null;
}

/** Makes the open and save dialogs of the main process answer with given paths, or be cancelled. */
export async function answerDialogs(
  application: ElectronApplication,
  paths: ChosenPaths,
): Promise<void> {
  await application.evaluate(
    ({ dialog }, chosen) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({
          canceled: chosen.open === null,
          filePaths: chosen.open === null ? [] : [chosen.open],
        });
      dialog.showSaveDialog = () =>
        Promise.resolve({ canceled: chosen.save === null, filePath: chosen.save ?? '' });
    },
    { open: paths.open ?? null, save: paths.save ?? null },
  );
}

/** Closes the application, answering "Don't save" if it asks whether to save a project that has no file yet. */
export async function closeDiscarding(application: ElectronApplication, page: Page): Promise<void> {
  const closing = application.close();
  const discard = page
    .getByRole('dialog', { name: 'Save this project?' })
    .getByRole('button', { name: "Don't save" })
    .click()
    .catch(() => undefined);
  await Promise.race([closing, discard]);
  await closing;
}
