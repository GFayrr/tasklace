import type { ElectronApplication } from '@playwright/test';

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
