<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { commandOf } from '../app/shortcuts';
  import Notices from './Notices.svelte';
  import StatusBar from './StatusBar.svelte';
  import TaskDetails from './TaskDetails.svelte';
  import Toolbar from './Toolbar.svelte';
  import Welcome from './Welcome.svelte';
  import Workspace from './Workspace.svelte';

  let { app }: { app: AppState } = $props();

  /** Runs the action of a keyboard shortcut, leaving undo and redo to a text field being edited. */
  function handleKey(event: KeyboardEvent): void {
    const target = event.target;
    const isEditingText =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    const command = commandOf(event, isEditingText);
    if (command === null) {
      return;
    }
    event.preventDefault();
    void app.run(command);
  }
</script>

<svelte:window onkeydown={handleKey} />

{#if app.project === null}
  <Welcome {app} />
{:else}
  <div class="shell">
    <Toolbar {app} />
    <Workspace {app} />
    <StatusBar {app} />
  </div>
  <TaskDetails {app} />
{/if}
<Notices {app} />

<style>
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
</style>
