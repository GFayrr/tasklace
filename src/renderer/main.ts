import type { AppState } from './app/app-state.svelte';
import { writeConsoleAsText } from './app/describe-for-log';
import { listenForUnexpectedErrors, startInterface } from './app/start-interface';
import { loadMessages } from './i18n/messages';
import { createScheduler } from './schedule/scheduler';
import { SAND_GRAPHITE } from './theme/sand-graphite';
import './styles/global.css';

let app: AppState | null = null;

writeConsoleAsText(console);
listenForUnexpectedErrors(window, reportUnexpectedError);

try {
  await startInterface(
    document,
    {
      bridge: window.tasklace,
      messages: await loadMessages('en'),
      locale: navigator.language,
      createScheduler: (listener) =>
        createScheduler(
          () =>
            new Worker(new URL('./schedule/schedule-worker.ts', import.meta.url), {
              type: 'module',
            }),
          listener,
        ),
      createId: () => crypto.randomUUID(),
      now: () => new Date(),
      theme: SAND_GRAPHITE,
    },
    (started) => {
      app = started;
    },
  );
} catch (error) {
  console.error('The interface could not start:', error);
  window.tasklace.reportStartFailure();
}

/** Shows an unexpected error to the user once the interface runs, and logs it in every case. */
function reportUnexpectedError(error: unknown): void {
  if (app === null) {
    console.error('Unexpected error while the interface starts:', error);
    return;
  }
  app.reportUnexpectedError(error);
}
