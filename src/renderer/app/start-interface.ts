import { mount } from 'svelte';
import App from '../components/App.svelte';
import { applyTheme } from '../theme/theme';
import { AppState, type AppContext } from './app-state.svelte';
import { errorOfEvent } from './describe-for-log';

/** Reports every error and rejected promise nothing else handled, the rejection being marked handled once reported. */
export function listenForUnexpectedErrors(
  target: Pick<Window, 'addEventListener'>,
  report: (error: unknown) => void,
): void {
  target.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    report(event.reason);
  });
  target.addEventListener('error', (event) => {
    report(errorOfEvent(event));
  });
}

/** Builds the state of the interface, shows it, answers the requests to close and what arrives from outside, and tells the caller once it runs, before the recent projects and the setup load, so that their errors reach the user. */
export async function startInterface(
  page: Document,
  context: AppContext,
  started: (app: AppState) => void,
): Promise<void> {
  const target = page.getElementById('app');
  if (target === null) {
    throw new Error('The page has no application root.');
  }
  applyTheme(context.theme, page.documentElement);
  const app = new AppState(context);
  context.bridge.onFlushRequested(() =>
    app.prepareClose().catch((error: unknown) => {
      app.reportUnexpectedError(error);
      return false;
    }),
  );
  context.bridge.onOutsideRequest(() => {
    app.takeOutsideRequest().catch((error: unknown) => {
      app.reportUnexpectedError(error);
    });
  });
  mount(App, { target, props: { app } });
  started(app);
  target.dataset['started'] = 'true';
  await app.loadRecentProjects();
  await app.startSetup();
}
