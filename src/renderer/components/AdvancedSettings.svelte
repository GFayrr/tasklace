<script lang="ts">
  import type { Project } from '../../core/model/project';
  import type { AppState } from '../app/app-state.svelte';
  import { createMomentFormatter } from '../i18n/format';
  import { fillMessage } from '../i18n/messages';
  import { toggleProjectOption, type BooleanProjectOption } from '../plan/project-commands';

  type Feature = 'criticalPath' | 'dateConstraints' | 'baseline' | 'alwaysShowPatterns';
  type Question = 'replace' | 'clear';

  let { app, project }: { app: AppState; project: Project } = $props();

  const text = $derived(app.messages.settings);
  const formatMoment = $derived(createMomentFormatter(app.locale));
  const HISTORY_KEYS: ReadonlySet<string> = new Set(['z', 'y']);
  const FEATURES: readonly Feature[] = [
    'criticalPath',
    'dateConstraints',
    'baseline',
    'alwaysShowPatterns',
  ];
  const CHOICES = {
    criticalPath: { option: 'criticalPathEnabled', hint: 'criticalPathHint' },
    dateConstraints: { option: 'dateConstraintsEnabled', hint: 'dateConstraintsHint' },
    baseline: { option: 'baselineEnabled', hint: 'baselineHint' },
    alwaysShowPatterns: { option: 'alwaysShowPatterns', hint: 'alwaysShowPatternsHint' },
  } as const satisfies Readonly<
    Record<Feature, { readonly option: BooleanProjectOption; readonly hint: keyof typeof text }>
  >;
  const questions = $derived({
    replace: {
      title: text.replaceBaselineTitle,
      body: text.replaceBaselineBody,
      confirm: text.replaceBaselineConfirm,
      danger: false,
      apply: () => app.setBaseline(),
    },
    clear: {
      title: text.clearBaselineTitle,
      body: text.clearBaselineBody,
      confirm: text.clearBaselineConfirm,
      danger: true,
      apply: () => app.clearBaseline(),
    },
  } satisfies Record<
    Question,
    {
      readonly title: string;
      readonly body: string;
      readonly confirm: string;
      readonly danger: boolean;
      readonly apply: () => string | null;
    }
  >);
  let refusal = $state<{ readonly text: string; readonly resets: number } | null>(null);
  let asking = $state<Question | null>(null);
  const shownRefusal = $derived(refusal?.resets === app.settingsResets ? refusal.text : null);

  /** Turns an option of the project on or off, showing the reason when it is refused. */
  function toggle(option: BooleanProjectOption): void {
    show(app.editSettings((context) => toggleProjectOption(context, option)));
  }

  /** Shows why a change was refused, or forgets an earlier refusal once a change is applied. */
  function show(refused: string | null): void {
    refusal = refused === null ? null : { text: refused, resets: app.settingsResets };
  }

  /** Sets the first baseline at once, or asks before replacing the one the project has. */
  function setBaseline(): void {
    if (project.baseline === null) {
      show(app.setBaseline());
    } else {
      asking = 'replace';
    }
  }

  /** Applies the change the user confirmed. */
  function confirm(question: Question): void {
    asking = null;
    show(questions[question].apply());
  }

  $effect(() => {
    if (!project.options.baselineEnabled || project.baseline === null) {
      asking = null;
    }
  });

  /** Opens the confirmation dialog as a modal while a question waits for an answer, and closes it otherwise. */
  function followQuestion(dialog: HTMLDialogElement): void {
    if (asking !== null && !dialog.open) {
      dialog.showModal();
    } else if (asking === null && dialog.open) {
      dialog.close();
    }
  }

  /** Keeps undo and redo from changing the baseline while the user is asked to confirm. */
  function holdHistory(dialog: HTMLDialogElement): () => void {
    const hold = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && HISTORY_KEYS.has(event.key.toLowerCase())) {
        event.stopPropagation();
      }
    };
    dialog.addEventListener('keydown', hold);
    return () => {
      dialog.removeEventListener('keydown', hold);
    };
  }
</script>

<div class="advanced">
  {#each FEATURES as feature (feature)}
    {@const { option, hint } = CHOICES[feature]}
    <div class="choice">
      <div class="words">
        <h3 id={`advanced-${feature}`}>{text[feature]}</h3>
        <p>{text[hint]}</p>
      </div>
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
      {#if feature === 'baseline' && project.options.baselineEnabled}
        <div class="baseline">
          {#if project.baseline === null}
            <span class="when">{text.baselineNone}</span>
            <button type="button" class="button primary" onclick={setBaseline}
              >{text.setBaseline}</button
            >
          {:else}
            <span class="when"
              >{fillMessage(text.baselineSetOn, {
                date: formatMoment(project.baseline.takenAt),
              })}</span
            >
            <button type="button" class="button" onclick={setBaseline}
              >{text.setBaselineAgain}</button
            >
            <button
              type="button"
              class="button quiet"
              onclick={() => {
                asking = 'clear';
              }}>{text.clearBaseline}</button
            >
          {/if}
        </div>
        {#if app.baselineNotice !== null}
          <p class="notice" role="status">{app.baselineNotice}</p>
        {/if}
      {/if}
    </div>
  {/each}
  {#if shownRefusal !== null}
    <p class="refusal" role="alert">{shownRefusal}</p>
  {/if}
</div>

<dialog
  class="confirm"
  aria-labelledby="baseline-question-title"
  {@attach followQuestion}
  {@attach holdHistory}
  onclose={(event) => {
    if (!event.currentTarget.open) {
      asking = null;
    }
  }}
>
  {#if asking !== null}
    {@const question = asking}
    {@const words = questions[question]}
    <h3 id="baseline-question-title">{words.title}</h3>
    <p>
      {fillMessage(words.body, {
        date: project.baseline === null ? '' : formatMoment(project.baseline.takenAt),
      })}
    </p>
    <div class="actions">
      <button
        type="button"
        class="button"
        onclick={() => {
          asking = null;
        }}>{text.cancel}</button
      >
      <button
        type="button"
        class={['button', { primary: !words.danger, danger: words.danger }]}
        onclick={() => {
          confirm(question);
        }}>{words.confirm}</button
      >
    </div>
  {/if}
</dialog>

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

  .baseline {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-background);
    border: 1px solid var(--color-panel);
    border-radius: var(--radius);
  }

  .notice {
    grid-column: 1 / -1;
    color: var(--color-warning);
  }

  .when {
    flex: 1;
    min-width: 180px;
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-3);
    font-weight: 500;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .button:hover {
    background: var(--color-panel);
  }

  .button.quiet {
    color: var(--color-text-secondary);
  }

  .button.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border-color: var(--color-action);
  }

  .button.danger {
    color: var(--color-action-text);
    background: var(--color-error);
    border-color: var(--color-error);
  }

  .confirm {
    width: min(420px, calc(100% - 32px));
    padding: var(--space-6);
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .confirm::backdrop {
    background: rgb(28 27 25 / 28%);
  }

  .confirm h3 {
    margin: 0 0 var(--space-3);
  }

  .confirm p {
    margin: 0 0 var(--space-4);
    font-size: var(--font-size);
    color: var(--color-text);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .refusal {
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    color: var(--color-error);
    border: 1px solid currentColor;
    border-radius: var(--radius);
  }
</style>
