import { mount } from 'svelte';
import { AppState } from './app/app-state.svelte';
import App from './components/App.svelte';
import { loadMessages } from './i18n/messages';
import { createScheduler } from './schedule/scheduler';
import { SAND_GRAPHITE } from './theme/sand-graphite';
import { applyTheme } from './theme/theme';
import './styles/global.css';

let app: AppState | null = null;

window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  reportUnexpectedError(event.reason);
});
window.addEventListener('error', (event) => {
  reportUnexpectedError(event.error);
});

try {
  await start();
} catch (error) {
  console.error('The interface could not start:', error);
  window.tasklace.reportStartFailure();
}

/** Builds the state of the interface, shows it and answers the requests to close the window. */
async function start(): Promise<void> {
  const target = document.getElementById('app');
  if (target === null) {
    throw new Error('The page has no application root.');
  }
  applyTheme(SAND_GRAPHITE, document.documentElement);
  const started = new AppState({
    bridge: window.tasklace,
    messages: await loadMessages('en'),
    locale: navigator.language,
    createScheduler: (listener) =>
      createScheduler(
        () =>
          new Worker(new URL('./schedule/schedule-worker.ts', import.meta.url), { type: 'module' }),
        listener,
      ),
    createId: () => crypto.randomUUID(),
    now: () => new Date(),
    theme: SAND_GRAPHITE,
  });
  window.tasklace.onFlushRequested(() =>
    started.prepareClose().catch((error: unknown) => {
      started.reportUnexpectedError(error);
      return false;
    }),
  );
  mount(App, { target, props: { app: started } });
  app = started;
  target.dataset['started'] = 'true';
  await started.loadRecentProjects();
}

/** Shows an unexpected error to the user once the interface runs, and logs it in every case. */
function reportUnexpectedError(error: unknown): void {
  if (app === null) {
    console.error('Unexpected error while the interface starts:', error);
    return;
  }
  app.reportUnexpectedError(error);
}
