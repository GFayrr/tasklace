import { createProjectFiles } from './project/project-files';

const root = document.getElementById('app');
const files = createProjectFiles(window.tasklace, reportFailure);

window.tasklace.onFlushRequested(() => files.flush());

if (root !== null) {
  root.dataset['started'] = 'true';
}

/** Reports a failure of an action the user did not start, until the interface can show it. */
function reportFailure(error: unknown): void {
  console.error(error);
}
