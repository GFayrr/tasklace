<script lang="ts">
  import { formatDateTime } from '../../core/civil-format';
  import type { Project } from '../../core/model/project';
  import type { AppState } from '../app/app-state.svelte';
  import { commitField } from './commit-field';

  let { app, project }: { app: AppState; project: Project } = $props();

  const text = $derived(app.messages.settings);
  const start = $derived(formatDateTime(project.startDate));
  let refusal = $state<{ readonly text: string; readonly resets: number } | null>(null);
  const shownRefusal = $derived(refusal?.resets === app.settings.resets ? refusal.text : null);

  /** Applies a change of a field, showing the reason for a refusal, putting the value of the project back in the field and holding the settings open once, or clearing the reason once applied. */
  function change(
    apply: () => string | null,
    field: HTMLInputElement,
    current: () => string,
  ): void {
    const refused = apply();
    refusal = refused === null ? null : { text: refused, resets: app.settings.resets };
    if (refused !== null) {
      field.value = current();
      app.settings.hold();
    }
  }
</script>

<div class="general">
  <label class="field">
    <span>{text.projectName}</span>
    <input
      id="settings-project-name"
      value={project.name}
      {@attach commitField(
        () => project.name,
        (value, field) => {
          change(
            () => app.renameFromSettings(value),
            field,
            () => project.name,
          );
        },
      )}
    />
  </label>
  <label class="field">
    <span>{text.projectStart}</span>
    <input
      id="settings-project-start"
      type="datetime-local"
      step="900"
      value={start}
      {@attach commitField(
        () => start,
        (value, field) => {
          change(
            () => app.moveProjectStart(value),
            field,
            () => start,
          );
        },
      )}
    />
    <small>{text.projectStartHint}</small>
  </label>
  {#if shownRefusal !== null}
    <p class="refusal" role="alert">{shownRefusal}</p>
  {/if}
  {#if app.settings.notice !== null}
    <p class="notice" role="status">{app.settings.notice}</p>
  {/if}
</div>

<style>
  .general {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-small);
    font-weight: 500;
  }

  .field input {
    height: var(--control-height);
    padding: 0 var(--space-2);
    font-size: var(--font-size);
    font-weight: 400;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  #settings-project-start {
    align-self: flex-start;
  }

  small {
    font-size: 12px;
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .refusal,
  .notice {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--font-size-small);
    border-radius: var(--radius);
  }

  .refusal {
    color: var(--color-error);
    border: 1px solid currentColor;
  }

  .notice {
    color: var(--color-text-secondary);
    background: var(--color-panel);
  }
</style>
