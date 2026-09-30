import { mount } from 'svelte';
import { AppState } from './app/app-state.svelte';
import App from './components/App.svelte';
import { loadMessages } from './i18n/messages';
import { createScheduler } from './schedule/scheduler';
import { SAND_GRAPHITE } from './theme/sand-graphite';
import { applyTheme } from './theme/theme';
import './styles/global.css';

const target = document.getElementById('app');
if (target === null) {
  throw new Error('The page has no application root.');
}
applyTheme(SAND_GRAPHITE, document.documentElement);
const app = new AppState({
  bridge: window.tasklace,
  messages: await loadMessages('en'),
  locale: navigator.language,
  createScheduler: (listener) =>
    createScheduler(
      new Worker(new URL('./schedule/schedule-worker.ts', import.meta.url), { type: 'module' }),
      listener,
    ),
  createId: () => crypto.randomUUID(),
  now: () => new Date(),
});
window.tasklace.onFlushRequested(() => app.flush());
mount(App, { target, props: { app } });
target.dataset['started'] = 'true';
void app.loadRecentProjects();
