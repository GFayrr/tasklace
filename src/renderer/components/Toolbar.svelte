<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { indentTask, moveTask, outdentTask, toggleMilestone } from '../plan/task-commands';
  import Icon, { type IconName } from './Icon.svelte';

  interface TaskAction {
    readonly icon: IconName;
    readonly label: string;
    readonly run: () => void;
  }
  import MenuButton, { type MenuItem } from './MenuButton.svelte';

  let { app }: { app: AppState } = $props();
  const text = $derived(app.messages);
  const status = $derived.by(() => {
    if (app.saveStatus !== 'saved') {
      return text.saveStatus[app.saveStatus];
    }
    return app.hasFile ? text.saveStatus.saved : text.saveStatus.localOnly;
  });
  const openItems: readonly MenuItem[] = $derived([
    { key: 'open', label: text.toolbar.openFile, select: () => void app.open() },
    ...app.recentProjects.map((recent, index) => ({
      key: `recent-${String(index)}`,
      label: recent.name,
      hint: recent.folder,
      select: () => void app.openRecent(index),
    })),
  ]);
  const importItems: readonly MenuItem[] = $derived([
    { key: 'csv', label: text.toolbar.importCsv, select: () => void app.importFile('csv') },
    { key: 'json', label: text.toolbar.importJson, select: () => void app.importFile('json') },
  ]);
  const exportItems: readonly MenuItem[] = $derived([
    { key: 'csv', label: text.toolbar.exportCsv, select: () => void app.exportFile('csv') },
    { key: 'json', label: text.toolbar.exportJson, select: () => void app.exportFile('json') },
  ]);

  const taskActions: readonly TaskAction[] = $derived([
    {
      icon: 'outdent',
      label: text.tasks.outdent,
      run: () => {
        app.editSelected(outdentTask);
      },
    },
    {
      icon: 'indent',
      label: text.tasks.indent,
      run: () => {
        app.editSelected(indentTask);
      },
    },
    {
      icon: 'up',
      label: text.tasks.moveUp,
      run: () => {
        app.editSelected((context, id) => moveTask(context, id, -1));
      },
    },
    {
      icon: 'down',
      label: text.tasks.moveDown,
      run: () => {
        app.editSelected((context, id) => moveTask(context, id, 1));
      },
    },
    {
      icon: 'sliders',
      label: text.tasks.details,
      run: () => {
        app.openDetails();
      },
    },
    {
      icon: 'diamond',
      label: text.tasks.milestone,
      run: () => {
        app.editSelected(toggleMilestone);
      },
    },
    {
      icon: 'trash',
      label: text.tasks.delete,
      run: () => {
        app.deleteSelected();
      },
    },
  ]);

  const projectName = $derived(app.project?.name ?? '');

  /** Renames the project when the name field is left, restoring the name if it was refused. */
  function commitName(event: Event & { currentTarget: HTMLInputElement }): void {
    const field = event.currentTarget;
    if (!app.rename(field.value)) {
      field.value = projectName;
    }
  }

  /** Leaves the name field with Enter, or restores its name with Escape. */
  function nameKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.key === 'Escape') {
      event.currentTarget.value = projectName;
    }
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.currentTarget.blur();
    }
  }
</script>

<header class="toolbar">
  <div class="identity">
    <input
      class="name"
      aria-label={text.toolbar.projectName}
      value={projectName}
      onchange={commitName}
      onkeydown={nameKey}
    />
    <span class="status" class:failed={app.saveStatus === 'failed'} role="status">
      {#if app.saveStatus === 'failed'}
        <Icon name="alert" />
      {:else if app.saveStatus === 'saved'}
        <Icon name="check" />
      {/if}
      <span>{status}</span>
    </span>
  </div>
  <nav class="group" aria-label={text.toolbar.fileActions}>
    <button type="button" class="button" onclick={() => app.newProject()}>
      <Icon name="plus" />
      <span>{text.toolbar.new}</span>
    </button>
    <MenuButton label={text.toolbar.open} items={openItems} />
    <MenuButton label={text.toolbar.import} items={importItems} />
    <MenuButton label={text.toolbar.export} items={exportItems} />
  </nav>
  <div class="group" role="group" aria-label={text.tasks.label}>
    <button
      type="button"
      class="button"
      onclick={() => {
        app.addTask();
      }}
    >
      <Icon name="plus" />
      <span>{text.tasks.add}</span>
    </button>
    {#each taskActions as action (action.icon)}
      <button
        type="button"
        class="icon-button"
        aria-label={action.label}
        title={action.label}
        disabled={app.selectedTaskId === null}
        onclick={action.run}
      >
        <Icon name={action.icon} />
      </button>
    {/each}
  </div>
  <div class="group" role="group" aria-label={text.toolbar.history}>
    <button
      type="button"
      class="icon-button"
      aria-label={text.toolbar.undo}
      disabled={!app.canUndo}
      onclick={() => {
        app.undo();
      }}
    >
      <Icon name="undo" />
    </button>
    <button
      type="button"
      class="icon-button"
      aria-label={text.toolbar.redo}
      disabled={!app.canRedo}
      onclick={() => {
        app.redo();
      }}
    >
      <Icon name="redo" />
    </button>
  </div>
  <div class="spacer"></div>
  <button type="button" class="button" class:primary={!app.hasFile} onclick={() => app.save()}>
    {text.toolbar.save}
  </button>
</header>

<style>
  .toolbar {
    min-height: 56px;
    padding: var(--space-2) var(--space-4);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }

  .identity {
    display: flex;
    flex-direction: column;
    min-width: 200px;
  }

  .name {
    width: 100%;
    padding: 2px var(--space-1);
    margin-left: calc(-1 * var(--space-1));
    font-size: var(--font-size-large);
    font-weight: 600;
    background: transparent;
    border: 1px solid transparent;
    border-radius: calc(var(--radius) - 2px);
    text-overflow: ellipsis;
  }

  .name:hover {
    border-color: var(--color-border);
  }

  .name:focus {
    background: var(--color-surface);
    border-color: var(--color-border);
  }

  .status {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  .status :global(.icon) {
    width: 14px;
    height: 14px;
  }

  .status.failed {
    color: var(--color-error);
    font-weight: 500;
  }

  .group {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .spacer {
    flex-grow: 1;
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-1);
    border-radius: var(--radius);
    font-weight: 500;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    cursor: pointer;
  }

  .button:hover {
    background: var(--color-panel);
  }

  .button.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border-color: var(--color-action);
  }

  .button.primary:hover {
    background: var(--color-action-hover);
  }

  .icon-button {
    width: var(--control-height);
    height: var(--control-height);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius);
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
  }

  .icon-button:hover:not(:disabled) {
    background: var(--color-panel);
  }

  .icon-button:disabled {
    color: var(--color-text-secondary);
    cursor: default;
    opacity: 0.5;
  }
</style>
