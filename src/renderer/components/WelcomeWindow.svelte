<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';

  let { app }: { app: AppState } = $props();
  const text = $derived(app.messages.setup);
  let associate = $state(true);
  let checkForNewVersions = $state(true);
  let finishing = $state(false);
  let notOpened = $state(false);

  /** Opens the window as a modal dialog while the welcome window asks its choices, and closes it otherwise. */
  function followOpening(dialog: HTMLDialogElement): void {
    $effect(() => {
      if (app.setup.welcome && !dialog.open) {
        dialog.showModal();
      }
      if (!app.setup.welcome && dialog.open) {
        dialog.close();
      }
    });
  }

  /** Gives the two choices to the application, which closes the window. */
  async function finish(): Promise<void> {
    finishing = true;
    await app.finishWelcome({ associate, checkForNewVersions });
    finishing = false;
  }

  /** Opens the privacy policy in the browser, telling when it could not open. */
  async function openPrivacyPolicy(): Promise<void> {
    notOpened = !(await app.updates.openPrivacyPolicy());
  }
</script>

<dialog
  class="welcome-window"
  aria-labelledby="welcome-window-title"
  {@attach followOpening}
  oncancel={(event) => {
    event.preventDefault();
  }}
>
  <h2 id="welcome-window-title">{text.welcomeTitle}</h2>
  <p class="hint">{text.welcomeIntro}</p>
  <section class="part">
    <div class="row">
      <h3 id="welcome-associate-title">{text.associateSwitch}</h3>
      <button
        type="button"
        class="switch"
        role="switch"
        aria-checked={associate}
        aria-labelledby="welcome-associate-title"
        onclick={() => {
          associate = !associate;
        }}
      ></button>
    </div>
    <p class="hint">{text.associateHint}</p>
  </section>
  <section class="part">
    <div class="row">
      <h3 id="welcome-check-title">{app.messages.tasklace.checkSwitch}</h3>
      <button
        type="button"
        class="switch"
        role="switch"
        aria-checked={checkForNewVersions}
        aria-labelledby="welcome-check-title"
        onclick={() => {
          checkForNewVersions = !checkForNewVersions;
        }}
      ></button>
    </div>
    <p class="hint">{text.checkHint}</p>
  </section>
  {#if notOpened}
    <p class="problem" role="alert">{app.messages.tasklace.notOpened}</p>
  {/if}
  <div class="actions">
    <button type="button" class="link" onclick={() => void openPrivacyPolicy()}
      >{app.messages.tasklace.privacyPolicy}</button
    >
    <button type="button" class="button primary" disabled={finishing} onclick={() => void finish()}
      >{text.continue}</button
    >
  </div>
</dialog>

<style>
  .welcome-window {
    width: min(480px, calc(100% - 32px));
    padding: var(--space-6);
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .welcome-window::backdrop {
    background: color-mix(in srgb, var(--color-text) 35%, transparent);
  }

  h2 {
    margin: 0 0 var(--space-1);
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

  .welcome-window > .hint {
    margin-bottom: var(--space-4);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .hint {
    margin: 0;
    font-size: 13px;
    color: var(--color-text-secondary);
  }

  .problem {
    margin: 0;
    font-size: 13px;
    color: var(--color-error);
  }

  .link {
    padding: 0;
    font: inherit;
    font-size: 13px;
    color: var(--color-focus);
    text-decoration: underline;
    text-underline-offset: 2px;
    background: none;
    border: 0;
    cursor: pointer;
  }

  .switch {
    position: relative;
    flex: none;
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
    align-items: center;
    justify-content: space-between;
    margin-top: var(--space-4);
  }
</style>
