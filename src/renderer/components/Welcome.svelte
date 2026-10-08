<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';

  let { app }: { app: AppState } = $props();
  const text = $derived(app.messages);
  let choosingImport = $state(false);
</script>

<div class="welcome">
  <div class="content">
    <header class="heading">
      <h1>{text.app.name}</h1>
      <p>{text.app.tagline}</p>
    </header>
    <div class="actions">
      <button type="button" class="action primary" onclick={() => app.newProject()}>
        <span class="label">{text.welcome.newProject}</span>
        <span class="hint">{text.welcome.newProjectHint}</span>
      </button>
      <button type="button" class="action" onclick={() => app.open()}>
        <span class="label">{text.welcome.open}</span>
        <span class="hint">{text.welcome.openHint}</span>
      </button>
      <button
        type="button"
        class="action"
        aria-expanded={choosingImport}
        aria-controls="import-kinds"
        onclick={() => (choosingImport = !choosingImport)}
      >
        <span class="label">{text.welcome.import}</span>
        <span class="hint">{text.welcome.importHint}</span>
      </button>
    </div>
    {#if choosingImport}
      <div class="import-kinds" id="import-kinds">
        <button type="button" class="import-kind" onclick={() => app.importFile('csv')}>
          {text.toolbar.importCsv}
        </button>
        <button type="button" class="import-kind" onclick={() => app.importFile('json')}>
          {text.toolbar.importJson}
        </button>
      </div>
    {/if}
    {#if app.recentProjects.length > 0}
      <section class="recent" aria-labelledby="recent-title">
        <h2 id="recent-title">{text.welcome.recent}</h2>
        {#each app.recentProjects as recent, index (index)}
          <button type="button" class="recent-project" onclick={() => app.openRecent(index)}>
            <span class="recent-name">{recent.name}</span>
            <span class="recent-folder">{recent.folder}</span>
          </button>
        {/each}
      </section>
    {/if}
  </div>
</div>

<style>
  .welcome {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
  }

  .content {
    width: 100%;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }

  .heading {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  h1 {
    margin: 0;
    font-size: var(--font-size-title);
    font-weight: 600;
  }

  p {
    margin: 0;
    font-size: var(--font-size-large);
    color: var(--color-text-secondary);
  }

  .actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .action {
    min-height: 76px;
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 2px;
    text-align: left;
    border-radius: calc(var(--radius) + 2px);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    cursor: pointer;
  }

  .action:hover {
    background: var(--color-panel);
  }

  .action.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border-color: var(--color-action);
  }

  .action.primary:hover {
    background: var(--color-action-hover);
  }

  .label {
    font-size: var(--font-size-large);
    font-weight: 600;
  }

  .hint {
    font-size: var(--font-size-small);
  }

  .import-kinds {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: calc(-1 * var(--space-6));
  }

  .import-kind {
    height: var(--control-height);
    padding: 0 var(--space-3);
    border-radius: var(--radius);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    cursor: pointer;
  }

  .import-kind:hover {
    background: var(--color-panel);
  }

  .recent {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  h2 {
    margin: 0;
    font-size: var(--font-size-small);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--color-text-secondary);
  }

  .recent-project {
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    border-radius: var(--radius);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    cursor: pointer;
  }

  .recent-project:hover {
    background: var(--color-panel);
  }

  .recent-name {
    font-size: 15px;
    font-weight: 500;
  }

  .recent-folder {
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }
</style>
