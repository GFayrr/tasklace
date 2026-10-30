<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { commandOf, type Command } from '../app/shortcuts';
  import { fillMessage } from '../i18n/messages';
  import ClosePrompt from './ClosePrompt.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import ConflictList from './ConflictList.svelte';
  import ReportDialog from './ReportDialog.svelte';
  import TasklaceSettings from './TasklaceSettings.svelte';
  import Notices from './Notices.svelte';
  import StatusBar from './StatusBar.svelte';
  import PdfExport from './PdfExport.svelte';
  import ProjectSettings from './ProjectSettings.svelte';
  import TaskDetails from './TaskDetails.svelte';
  import Toolbar from './Toolbar.svelte';
  import JoinWindow from './JoinWindow.svelte';
  import ShareWindow from './ShareWindow.svelte';
  import Welcome from './Welcome.svelte';
  import Workspace from './Workspace.svelte';

  let { app }: { app: AppState } = $props();

  const SETTINGS_COMMANDS: readonly Command[] = ['undo', 'redo'];

  /** Runs the action of a keyboard shortcut, leaving undo and redo to a field being edited and committing it first for other actions, and none while a file action runs or a window is open, the settings allowing undo and redo only. */
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
      app.pdfExport !== null ||
      app.collaborationWindow !== null ||
      app.keptChanges !== null ||
      app.isTasklaceSettingsOpen ||
      (app.settings.isOpen && !SETTINGS_COMMANDS.includes(command))
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
  <PdfExport {app} project={app.project} />
  <ShareWindow {app} project={app.project} />
{/if}
<JoinWindow {app} />
<ConfirmDialog
  question={app.keptChanges === null
    ? null
    : {
        title: app.messages.collaboration.keptTitle,
        body: fillMessage(app.messages.collaboration.keptBody, {
          plan: app.keptChanges.planName,
          copy: app.keptChanges.copyName,
        }),
        confirm: app.messages.collaboration.openKept,
        danger: false,
      }}
  titleId="kept-changes-title"
  cancel={app.messages.collaboration.keptDone}
  main="cancel"
  confirmed={() => void app.openKeptChanges()}
  dismissed={() => {
    app.closeKeptChanges();
  }}
/>
<Notices {app} />
<ClosePrompt {app} />
<ReportDialog {app} />
<TasklaceSettings {app} />

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
