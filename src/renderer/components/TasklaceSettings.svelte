<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { fillMessage } from '../i18n/messages';

  let { app }: { app: AppState } = $props();
  const text = $derived(app.messages.tasklace);
  const updates = $derived(app.updates);
  const setupText = $derived(app.messages.setup);
  const association = $derived(app.setup.association);
  let notKept = $state(false);
  let notOpened = $state(false);
  let notChanged = $state(false);
  let changing = $state(false);

  /** Opens the window as a modal dialog while the settings are open, and closes it otherwise. */
  function followOpening(dialog: HTMLDialogElement): void {
    $effect(() => {
      if (app.isTasklaceSettingsOpen && !dialog.open) {
        notKept = false;
        notOpened = false;
        notChanged = false;
        void app.setup.load();
        dialog.showModal();
      }
      if (!app.isTasklaceSettingsOpen && dialog.open) {
        dialog.close();
      }
    });
  }

  /** Turns the check for new versions on or off, telling when this computer could not keep the choice. */
  async function toggleCheck(): Promise<void> {
    notKept = !(await updates.setCheck(updates.checkForNewVersions !== true));
  }

  /** Makes this copy open project files and links or stops it, telling when it could not be changed. */
  async function toggleAssociation(on: boolean): Promise<void> {
    changing = true;
    notChanged = !(await app.setFileAssociation(on));
    changing = false;
  }

  /** Opens a page in the browser, telling when it could not open. */
  async function open(opening: Promise<boolean>): Promise<void> {
    notOpened = !(await opening);
  }

  /** Writes the time of a check the way this computer writes hours. */
  function timeOf(moment: Date): string {
    return new Intl.DateTimeFormat(app.locale, { timeStyle: 'short' }).format(moment);
  }
</script>

<dialog
  class="tasklace-settings"
  aria-labelledby="tasklace-settings-title"
  {@attach followOpening}
  oncancel={() => {
    app.closeTasklaceSettings();
  }}
  onclose={(event) => {
    if (!event.currentTarget.open) {
      app.closeTasklaceSettings();
    }
  }}
>
  <header>
    <h2 id="tasklace-settings-title">{text.title}</h2>
    <span class="hint">{text.keptHere}</span>
  </header>
  <section class="part" aria-labelledby="tasklace-version-title">
    <h3 id="tasklace-version-title">{text.versionHeading}</h3>
    <div class="row">
      <span
        >{updates.version === null
          ? ''
          : fillMessage(text.version, { version: updates.version })}</span
      >
      <button
        type="button"
        class="button"
        disabled={updates.status.kind === 'checking'}
        onclick={() => void updates.checkNow()}>{text.checkNow}</button
      >
    </div>
    <p class="status" role="status">
      {#if updates.status.kind === 'checking'}
        {text.checking}
      {:else if updates.status.kind === 'latest'}
        {fillMessage(text.latest, { time: timeOf(updates.status.checkedAt) })}
      {:else if updates.status.kind === 'newer'}
        {@const version = updates.status.version}
        {fillMessage(text.newer, { version })}
        <button
          type="button"
          class="link"
          onclick={() => void open(updates.openReleasePage(version))}
          >{app.messages.notices.openReleasePage}</button
        >
      {:else if updates.status.kind === 'failed'}
        {text.failed}
      {:else if updates.checkForNewVersions === false}
        {text.checkOff}
      {/if}
    </p>
  </section>
  <section class="part">
    <div class="row">
      <h3 id="tasklace-check-title">{text.checkSwitch}</h3>
      <button
        type="button"
        class="switch"
        role="switch"
        aria-checked={updates.checkForNewVersions === true}
        aria-labelledby="tasklace-check-title"
        disabled={updates.checkForNewVersions === null}
        onclick={() => void toggleCheck()}
      ></button>
    </div>
    <p class="hint">
      {text.checkHint}
      <button type="button" class="link" onclick={() => void open(updates.openPrivacyPolicy())}
        >{text.privacyPolicy}</button
      >
    </p>
    {#if notKept}
      <p class="problem" role="alert">{text.notKept}</p>
    {/if}
  </section>
  {#if association !== null && association.kind !== 'unavailable'}
    <section class="part" aria-labelledby="tasklace-files-title">
      <h3 id="tasklace-files-title">{setupText.filesHeading}</h3>
      <div class="row">
        <span id="tasklace-associate-title">{setupText.associateSwitch}</span>
        <button
          type="button"
          class="switch"
          role="switch"
          aria-checked={association.kind === 'thisCopy'}
          aria-labelledby="tasklace-associate-title"
          disabled={changing}
          onclick={() => void toggleAssociation(association.kind !== 'thisCopy')}
        ></button>
      </div>
      {#if association.kind === 'thisCopy'}
        <p class="hint">{setupText.thisCopy}</p>
      {:else if association.kind === 'otherCopy'}
        <p class="hint">{setupText.otherCopy}</p>
        <p class="path">{association.path}</p>
      {:else}
        <p class="hint">{setupText.noCopy}</p>
      {/if}
      {#if notChanged}
        <p class="problem" role="alert">{setupText.notChanged}</p>
      {/if}
    </section>
  {/if}
  {#if notOpened}
    <p class="problem" role="alert">{text.notOpened}</p>
  {/if}
  <div class="actions">
    <button
      type="button"
      class="button primary"
      onclick={() => {
        app.closeTasklaceSettings();
      }}>{text.done}</button
    >
  </div>
</dialog>

<style>
  .tasklace-settings {
    width: min(480px, calc(100% - 32px));
    padding: var(--space-6);
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .tasklace-settings::backdrop {
    background: color-mix(in srgb, var(--color-text) 35%, transparent);
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }

  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 500;
  }

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }

  .part {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3) 0;
    border-top: 1px solid var(--color-border);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .hint,
  .status {
    margin: 0;
    font-size: 13px;
    color: var(--color-text-secondary);
  }

  .path {
    margin: 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .row > span {
    font-size: 14px;
  }

  .problem {
    margin: 0;
    font-size: 13px;
    color: var(--color-error);
  }

  .link {
    padding: 0;
    font: inherit;
    color: var(--color-focus);
    text-decoration: underline;
    text-underline-offset: 2px;
    background: none;
    border: 0;
    cursor: pointer;
  }

  .switch {
    position: relative;
    width: 38px;
    height: 22px;
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

  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-4);
  }
</style>
