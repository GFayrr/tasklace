<script lang="ts">
  import type { Project } from '../../core/model/project';
  import type { AppState } from '../app/app-state.svelte';
  import { toggleProjectOption, type BooleanProjectOption } from '../plan/project-commands';

  type Feature = 'criticalPath' | 'dateConstraints' | 'baseline' | 'alwaysShowPatterns';

  let { app, project }: { app: AppState; project: Project } = $props();

  const text = $derived(app.messages.settings);
  const FEATURES: readonly Feature[] = [
    'criticalPath',
    'dateConstraints',
    'baseline',
    'alwaysShowPatterns',
  ];
  const CHOICES = {
    criticalPath: { option: 'criticalPathEnabled', hint: 'criticalPathHint' },
    dateConstraints: { option: 'dateConstraintsEnabled', hint: 'dateConstraintsHint' },
    baseline: { option: null, hint: 'baselineHint' },
    alwaysShowPatterns: { option: 'alwaysShowPatterns', hint: 'alwaysShowPatternsHint' },
  } as const satisfies Readonly<
    Record<
      Feature,
      { readonly option: BooleanProjectOption | null; readonly hint: keyof typeof text }
    >
  >;
  let refusal = $state<{ readonly text: string; readonly resets: number } | null>(null);
  const shownRefusal = $derived(refusal?.resets === app.settingsResets ? refusal.text : null);

  /** Turns an option of the project on or off, showing the reason when it is refused. */
  function toggle(option: BooleanProjectOption): void {
    const refused = app.editSettings((context) => toggleProjectOption(context, option));
    refusal = refused === null ? null : { text: refused, resets: app.settingsResets };
  }
</script>

<div class="advanced">
  {#each FEATURES as feature (feature)}
    {@const { option, hint } = CHOICES[feature]}
    <div class="choice">
      <div class="words">
        <h3 id={`advanced-${feature}`}>{text[feature]}</h3>
        <p>{text[hint]}</p>
        {#if option === null}
          <span class="soon">{text.soon}</span>
        {/if}
      </div>
      {#if option === null}
        <button
          type="button"
          class="switch"
          role="switch"
          aria-checked="false"
          aria-disabled="true"
          aria-labelledby={`advanced-${feature}`}
        ></button>
      {:else}
        <button
          type="button"
          class="switch"
          role="switch"
          aria-checked={project.options[option]}
          aria-labelledby={`advanced-${feature}`}
          onclick={() => {
            toggle(option);
          }}
        ></button>
      {/if}
    </div>
  {/each}
  {#if shownRefusal !== null}
    <p class="refusal" role="alert">{shownRefusal}</p>
  {/if}
</div>

<style>
  .advanced {
    display: flex;
    flex-direction: column;
  }

  .choice {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-2) var(--space-4);
    align-items: start;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-panel);
  }

  .choice:last-of-type {
    border-bottom: 0;
  }

  h3 {
    margin: 0;
    font-size: var(--font-size);
    font-weight: 600;
  }

  p {
    margin: 0;
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  .soon {
    font-size: 12px;
    color: var(--color-text-secondary);
    opacity: 0.8;
  }

  .switch {
    position: relative;
    width: 38px;
    height: 22px;
    margin-top: 2px;
    padding: 0;
    background: var(--color-border);
    border: 0;
    border-radius: 999px;
    cursor: pointer;
  }

  .switch::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--color-surface);
    box-shadow: 0 1px 2px rgb(0 0 0 / 20%);
  }

  .switch[aria-checked='true'] {
    background: var(--color-action);
  }

  .switch[aria-checked='true']::after {
    left: 19px;
  }

  .switch[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .refusal {
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    color: var(--color-error);
    border: 1px solid currentColor;
    border-radius: var(--radius);
  }
</style>
