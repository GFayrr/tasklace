import type { ElectronApplication } from '@playwright/test';

const REPLACE_LABEL = 'Replace';

export interface ChosenPaths {
  readonly open?: string | null;
  readonly save?: string | null;
  readonly replace?: boolean;
}

/** Makes the open and save dialogs of the main process answer with given paths or be cancelled, records the path the save dialog suggests, and answers the question about replacing a file, refusing any other question. */
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
      dialog.showSaveDialog = (...values: unknown[]) => {
        const options = values.find(
          (value): value is { defaultPath?: string } =>
            typeof value === 'object' && value !== null && 'filters' in value,
        );
        Object.assign(globalThis, { suggestedPath: options?.defaultPath ?? null });
        return Promise.resolve({ canceled: chosen.save === null, filePath: chosen.save ?? '' });
      };
      dialog.showMessageBox = (...values: unknown[]) => {
        const options = values.find(
          (value): value is { message: string; buttons?: string[] } =>
            typeof value === 'object' && value !== null && 'message' in value,
        );
        if (options?.buttons?.[0] !== chosen.replaceLabel) {
          return Promise.reject(new Error(`Unexpected question: ${options?.message ?? ''}`));
        }
        Object.assign(globalThis, { askedQuestion: options.message });
        return Promise.resolve({ response: chosen.replace ? 0 : 1, checkboxChecked: false });
      };
    },
    {
      open: paths.open ?? null,
      save: paths.save ?? null,
      replace: paths.replace ?? false,
      replaceLabel: REPLACE_LABEL,
    },
  );
}

/** Returns the path the last save dialog suggested to the user. */
export async function suggestedPath(application: ElectronApplication): Promise<string | null> {
  return application.evaluate(() => {
    const recorded: unknown = Reflect.get(globalThis, 'suggestedPath');
    return typeof recorded === 'string' ? recorded : null;
  });
}

/** Returns the last question the main process asked about replacing a file, or null when it asked none. */
export async function askedQuestion(application: ElectronApplication): Promise<string | null> {
  return application.evaluate(() => {
    const recorded: unknown = Reflect.get(globalThis, 'askedQuestion');
    return typeof recorded === 'string' ? recorded : null;
  });
}
