<script lang="ts">
  import { FIRST_PORT, isPort, LAST_PORT } from '../../core/collaboration/ports';
  import { readJoinCode } from '../../core/collaboration/secure/join-code';
  import { MAX_PARTICIPANT_NAME_LENGTH } from '../../core/limits';
  import type { NearbyPlan } from '../../preload/bridge-contract';
  import type { AppState } from '../app/app-state.svelte';
  import {
    collaborationFailureText,
    joinEndText,
    preferredAddress,
  } from '../collaboration/collaboration-text';
  import { fillMessage } from '../i18n/messages';
  import Icon from './Icon.svelte';

  let { app }: { app: AppState } = $props();

  let codeDraft = $state('');
  let addressDraft = $state('');
  let portDraft = $state<number | null>(null);
  let nameDraft = $state('');
  let chosen = $state.raw<NearbyPlan | null>(null);
  let attempted = $state(false);
  let refusal = $state<string | null>(null);

  const text = $derived(app.messages.collaboration);
  const collaboration = $derived(app.collaboration);
  const joining = $derived(collaboration.mode.kind === 'joining');
  const ended = $derived.by(() => {
    const reason = collaboration.lastEnd;
    if (!attempted || collaboration.mode.kind !== 'idle' || reason === null) {
      return null;
    }
    return joinEndText(app.messages, reason, chosen?.hostName ?? text.theHost);
  });
  const message = $derived(refusal ?? ended);

  /** Opens the dialog empty, with the name and port of this computer, when the join window opens, and closes it when it is closed elsewhere. */
  function followOpening(dialog: HTMLDialogElement): void {
    const isOpen = app.collaborationWindow === 'join';
    if (isOpen && !dialog.open) {
      codeDraft = '';
      addressDraft = '';
      portDraft = collaboration.settings?.port ?? null;
      nameDraft = collaboration.settings?.name ?? '';
      chosen = null;
      attempted = false;
      refusal = null;
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }

  /** Chooses a plan found nearby, filling in its address and port. */
  function choose(plan: NearbyPlan): void {
    chosen = plan;
    addressDraft = preferredAddress(plan) ?? '';
    portDraft = plan.port;
  }

  /** Gives why what was typed cannot be used to join, or null when it can. */
  function typingRefusal(name: string, code: string | null): string | null {
    if (name === '') {
      return text.noName;
    }
    if (code === null) {
      return text.invalidCode;
    }
    if (addressDraft.trim() === '') {
      return text.noTarget;
    }
    if (!isPort(portDraft ?? Number.NaN)) {
      return fillMessage(text.invalidPort, { first: String(FIRST_PORT), last: String(LAST_PORT) });
    }
    return null;
  }

  /** Joins the plan with what was typed, keeping the name on this computer first, and shows why it could not be joined. */
  async function join(): Promise<void> {
    const name = nameDraft.trim();
    const code = readJoinCode(codeDraft);
    refusal = typingRefusal(name, code);
    if (refusal !== null || code === null) {
      return;
    }
    if (name !== collaboration.settings?.name && !(await collaboration.rename(name)).ok) {
      refusal = text.nameNotKept;
      return;
    }
    attempted = true;
    const joined = await app.join({
      address: addressDraft.trim(),
      port: portDraft ?? Number.NaN,
      code,
    });
    if (joined === null) {
      attempted = false;
      return;
    }
    refusal = joined.ok ? null : collaborationFailureText(app.messages, joined.error);
  }
</script>

<dialog
  class="join"
  aria-labelledby="join-title"
  {@attach followOpening}
  oncancel={() => {
    app.closeCollaborationWindow();
  }}
  onclose={(event) => {
    if (!event.currentTarget.open) {
      app.closeCollaborationWindow();
    }
  }}
>
  {#if app.collaborationWindow === 'join'}
    <div class="head">
      <h2 id="join-title">{text.joinTitle}</h2>
      <button
        type="button"
        class="icon-button"
        aria-label={text.close}
        title={text.close}
        onclick={() => {
          app.closeCollaborationWindow();
        }}
      >
        <Icon name="close" />
      </button>
    </div>
    <fieldset class="body" disabled={joining}>
      <section aria-labelledby="join-nearby-title">
        <h3 id="join-nearby-title">{text.nearby}</h3>
        {#if collaboration.nearbyPlans.length === 0}
          <p class="hint">{text.noneNearby}</p>
        {:else}
          <ul class="plans">
            {#each collaboration.nearbyPlans as plan (plan.key)}
              <li>
                <button
                  type="button"
                  class={['plan', { chosen: chosen?.key === plan.key }]}
                  aria-pressed={chosen?.key === plan.key}
                  onclick={() => {
                    choose(plan);
                  }}
                >
                  <span class="plan-name">{plan.planName}</span>
                  <span class="host">{plan.hostName}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
      <label class="field">
        <span>{text.code}</span>
        <input
          id="join-code"
          class="code"
          bind:value={codeDraft}
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <details class="address">
        <summary>{text.byAddress}</summary>
        <div class="address-fields">
          <label class="field grow">
            <span>{text.hostAddress}</span>
            <input
              id="join-address"
              bind:value={addressDraft}
              autocomplete="off"
              spellcheck="false"
              oninput={() => {
                chosen = null;
              }}
            />
          </label>
          <label class="field">
            <span>{text.port}</span>
            <input
              id="join-port"
              class="port"
              type="number"
              min={FIRST_PORT}
              max={LAST_PORT}
              bind:value={portDraft}
              oninput={() => {
                chosen = null;
              }}
            />
          </label>
        </div>
      </details>
      <label class="field">
        <span>{text.name}</span>
        <input
          id="join-name"
          bind:value={nameDraft}
          maxlength={MAX_PARTICIPANT_NAME_LENGTH}
          autocomplete="off"
        />
      </label>
      {#if message !== null}
        <p class="message" role="alert">{message}</p>
      {/if}
    </fieldset>
    <div class="foot">
      <button
        type="button"
        class="button"
        onclick={() => {
          app.closeCollaborationWindow();
        }}>{text.cancel}</button
      >
      <button
        type="button"
        class="button primary"
        disabled={joining}
        onclick={() => {
          void join();
        }}>{joining ? text.joining : text.join}</button
      >
    </div>
  {/if}
</dialog>

<style>
  .join {
    width: min(460px, calc(100% - 32px));
    max-height: calc(100% - 64px);
    padding: 0;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .join[open] {
    display: flex;
    flex-direction: column;
  }

  .join::backdrop {
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

  h3 {
    margin: 0 0 var(--space-2);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .body {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-6);
    overflow: auto;
    border: 0;
  }

  .hint {
    margin: 0;
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  .plans {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .plans li + li {
    border-top: 1px solid var(--color-border);
  }

  .plan {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    text-align: left;
    background: transparent;
    border: 0;
    cursor: pointer;
  }

  .plan:hover {
    background: var(--color-panel);
  }

  .plan.chosen {
    background: var(--color-selection);
    box-shadow: inset 3px 0 0 var(--color-action);
  }

  .plan-name {
    font-weight: 500;
  }

  .host {
    color: var(--color-text-secondary);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--font-size-small);
    font-weight: 500;
  }

  .field input {
    height: var(--control-height);
    padding: 0 var(--space-2);
    font: inherit;
    font-weight: 400;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .field .code {
    height: 44px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: 0.3em;
    text-transform: uppercase;
  }

  .address summary {
    font-size: var(--font-size-small);
    font-weight: 500;
    cursor: pointer;
  }

  .address-fields {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .grow {
    flex: 1;
  }

  .port {
    width: 96px;
  }

  .message {
    margin: 0;
    font-size: var(--font-size-small);
    color: var(--color-error);
  }

  .foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-6);
    background: var(--color-background);
    border-top: 1px solid var(--color-border);
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-4);
    font-weight: 500;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .button.primary {
    color: var(--color-action-text);
    background: var(--color-action);
    border-color: var(--color-action);
  }

  .button:disabled {
    opacity: 0.5;
    cursor: default;
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
