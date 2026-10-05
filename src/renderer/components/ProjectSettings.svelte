<script lang="ts">
  import type { Project } from '../../core/model/project';
  import { valueAt } from '../../core/table-value';
  import type { AppState } from '../app/app-state.svelte';
  import CalendarSettings from './CalendarSettings.svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import Icon from './Icon.svelte';

  let { app, project }: { app: AppState; project: Project } = $props();

  const text = $derived(app.messages.settings);
  const OPEN_TABS = ['general', 'calendar'] as const;
  const LATER_TABS = ['tags', 'advanced'] as const;
  const TAB_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 };
  let tab = $state<(typeof OPEN_TABS)[number]>('general');

  /** Opens the dialog on the General tab when the settings open, and closes it when they are closed elsewhere. */
  function followOpening(dialog: HTMLDialogElement): void {
    if (app.settingsOpen && !dialog.open) {
      tab = 'general';
      dialog.showModal();
    } else if (!app.settingsOpen && dialog.open) {
      dialog.close();
    }
  }

  /** Selects and focuses the previous or next available tab with the left and right arrow keys, wrapping around at the ends. */
  function moveTab(event: KeyboardEvent): void {
    const step = Object.hasOwn(TAB_STEPS, event.key) ? TAB_STEPS[event.key] : undefined;
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    const index = OPEN_TABS.indexOf(tab);
    tab = valueAt(OPEN_TABS, (index + step + OPEN_TABS.length) % OPEN_TABS.length);
    document.getElementById(`settings-tab-${tab}`)?.focus();
  }

  /** Closes the settings once the field being edited has handed over its value, unless that value was refused: they then stay open on its reason, telling whether they closed. */
  function close(): boolean {
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement) {
      focused.blur();
    }
    return app.closeSettingsUnlessHeld();
  }
</script>

<dialog
  class="settings"
  aria-labelledby="settings-title"
  {@attach followOpening}
  oncancel={(event) => {
    if (!close()) {
      event.preventDefault();
    }
  }}
  onclose={() => {
    app.closeSettings();
  }}
>
  <div class="head">
    <h2 id="settings-title">{text.title}</h2>
    <button
      type="button"
      class="icon-button"
      aria-label={text.close}
      title={text.close}
      onclick={close}
    >
      <Icon name="close" />
    </button>
  </div>
  <div class="tabs" role="tablist" tabindex="-1" onkeydown={moveTab}>
    {#each OPEN_TABS as name (name)}
      <button
        type="button"
        role="tab"
        id={`settings-tab-${name}`}
        aria-selected={tab === name}
        aria-controls="settings-panel"
        tabindex={tab === name ? 0 : -1}
        class={['tab', { active: tab === name }]}
        onclick={() => {
          tab = name;
        }}>{text[name]}</button
      >
    {/each}
    {#each LATER_TABS as name (name)}
      <button
        type="button"
        role="tab"
        class="tab later"
        aria-selected="false"
        aria-disabled="true"
        tabindex="-1"
        title={text.soon}>{text[name]}</button
      >
    {/each}
  </div>
  <div class="panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
    {#if tab === 'general'}
      <GeneralSettings {app} {project} />
    {:else}
      <CalendarSettings {app} {project} />
    {/if}
  </div>
  {#if app.settingsAlert !== null}
    <p class="alert" role="alert">{app.settingsAlert}</p>
  {/if}
  <div class="foot">
    <small>{text.undoHint}</small>
    <button type="button" class="button primary" onclick={close}>{text.done}</button>
  </div>
</dialog>

<style>
  .settings {
    width: min(560px, calc(100% - 32px));
    max-height: calc(100% - 64px);
    padding: 0;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .settings[open] {
    display: flex;
    flex-direction: column;
  }

  .settings::backdrop {
    background: color-mix(in srgb, var(--color-text) 35%, transparent);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-6) var(--space-1);
  }

  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }

  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--color-border);
    overflow-x: auto;
  }

  .tab {
    padding: var(--space-2) var(--space-3);
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    white-space: nowrap;
  }

  .tab.active {
    color: var(--color-text);
    font-weight: 500;
    border-bottom-color: var(--color-action);
  }

  .tab.later {
    cursor: default;
    opacity: 0.6;
  }

  .panel {
    padding: var(--space-4) var(--space-6);
    overflow-y: auto;
  }

  .alert {
    margin: 0 var(--space-6) var(--space-3);
    padding: var(--space-2) var(--space-3);
    font-size: var(--font-size-small);
    color: var(--color-error);
    border: 1px solid currentColor;
    border-radius: var(--radius);
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-6);
    background: var(--color-background);
    border-top: 1px solid var(--color-border);
  }

  small {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-4);
    font-weight: 500;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .button.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border: 1px solid var(--color-action);
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
    color: var(--color-text-secondary);
    background: none;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .icon-button:hover {
    background: var(--color-panel);
  }
</style>
