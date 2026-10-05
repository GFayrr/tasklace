<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { commandOf, type Command } from '../app/shortcuts';
  import ClosePrompt from './ClosePrompt.svelte';
  import ConflictList from './ConflictList.svelte';
  import ReportDialog from './ReportDialog.svelte';
  import Notices from './Notices.svelte';
  import StatusBar from './StatusBar.svelte';
  import ProjectSettings from './ProjectSettings.svelte';
  import TaskDetails from './TaskDetails.svelte';
  import Toolbar from './Toolbar.svelte';
  import Welcome from './Welcome.svelte';
  import Workspace from './Workspace.svelte';

  let { app }: { app: AppState } = $props();

  const SETTINGS_COMMANDS: readonly Command[] = ['undo', 'redo'];

  /** Runs the action of a keyboard shortcut, leaving undo and redo to a text field being edited and committing that field first for any other action, and runs none while a file action runs or a dialog is open, the project settings allowing undo and redo only. */
  function handleKey(event: KeyboardEvent): void {
    const target = event.target;
    const isEditingText =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    const command = commandOf(event, isEditingText);
    if (
      command === null ||
      app.fileActionRunning ||
      app.closePrompt !== null ||
      app.report !== null ||
      app.detailsTaskId !== null ||
      (app.settingsOpen && !SETTINGS_COMMANDS.includes(command))
    ) {
      return;
    }
    event.preventDefault();
    if (isEditingText) {
      target.blur();
    }
    void app.run(command);
  }
</script>

<svelte:window onkeydown={handleKey} />

{#if app.project === null}
  <Welcome {app} />
{:else}
  <div class="shell" inert={app.fileActionRunning} aria-busy={app.fileActionRunning}>
    <Toolbar {app} />
    {#key app.openedCount}
      <Workspace {app} project={app.project} />
    {/key}
    <ConflictList {app} />
    <StatusBar {app} />
  </div>
  <TaskDetails {app} project={app.project} />
  <ProjectSettings {app} project={app.project} />
{/if}
<Notices {app} />
<ClosePrompt {app} />
<ReportDialog {app} />

<style>
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .shell[aria-busy='true'] {
    cursor: progress;
  }
</style>
