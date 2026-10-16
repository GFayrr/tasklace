<script lang="ts">
  import type { Participant } from '../../core/collaboration/participants';
  import {
    DEFAULT_COLLABORATION_PORT,
    FIRST_PORT,
    isPort,
    LAST_PORT,
  } from '../../core/collaboration/ports';
  import { MAX_PARTICIPANT_NAME_LENGTH } from '../../core/limits';
  import type { Project } from '../../core/model/project';
  import type { AppState } from '../app/app-state.svelte';
  import { collaborationFailureText } from '../collaboration/collaboration-text';
  import { fillMessage } from '../i18n/messages';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Icon from './Icon.svelte';
  import PersonBadge from './PersonBadge.svelte';

  let { app, project }: { app: AppState; project: Project } = $props();

  let nameDraft = $state('');
  let portDraft = $state<number | null>(null);
  let nameError = $state<string | null>(null);
  let portError = $state<string | null>(null);
  let copied = $state<'copied' | 'failed' | null>(null);
  let askingFirewall = $state(false);
  let starting = $state(false);

  const text = $derived(app.messages.collaboration);
  const collaboration = $derived(app.collaboration);
  const sharing = $derived(
    collaboration.mode.kind === 'hosting' ? collaboration.mode.sharing : null,
  );
  const settings = $derived(collaboration.settings);
  const timeFormat = $derived(
    new Intl.DateTimeFormat(app.locale, { hour: 'numeric', minute: '2-digit' }),
  );
  const failure = $derived(
    app.shareFailure === null ? null : collaborationFailureText(app.messages, app.shareFailure),
  );

  /** Opens the dialog with the name and port of this computer when the share window opens, and closes it when it is closed elsewhere. */
  function followOpening(dialog: HTMLDialogElement): void {
    const isOpen = app.collaborationWindow === 'share';
    if (isOpen && !dialog.open) {
      nameDraft = collaboration.settings?.name ?? '';
      portDraft = collaboration.settings?.port ?? DEFAULT_COLLABORATION_PORT;
      nameError = null;
      portError = null;
      copied = null;
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }

  /** Keeps the name typed on this computer, refusing an empty one, and tells whether a name is kept. */
  async function commitName(): Promise<boolean> {
    const name = nameDraft.trim();
    if (name === '') {
      nameError = text.noName;
      return false;
    }
    nameError = null;
    if (name === settings?.name) {
      return true;
    }
    const renamed = await collaboration.rename(name);
    nameError = renamed.ok ? null : text.nameNotKept;
    return renamed.ok;
  }

  /** Keeps the port typed for the next time this computer shares, refusing a number that is not a port. */
  async function commitPort(): Promise<void> {
    const port = portDraft ?? Number.NaN;
    if (!isPort(port)) {
      portError = fillMessage(text.invalidPort, {
        first: String(FIRST_PORT),
        last: String(LAST_PORT),
      });
      return;
    }
    const saved = await collaboration.saveSettings({ port });
    portError = saved.ok ? null : text.portNotKept;
  }

  /** Shares the plan once the name is kept, telling first, a single time, that the computer may ask about the network. */
  async function start(): Promise<void> {
    if (!(await commitName())) {
      return;
    }
    if (settings?.firewallNoticeSeen !== true) {
      askingFirewall = true;
      return;
    }
    await share();
  }

  /** Remembers that the word about the network was seen, logging a failure to keep it since sharing can go on, then shares. */
  async function firewallSeen(): Promise<void> {
    askingFirewall = false;
    const saved = await collaboration.saveSettings({ firewallNoticeSeen: true });
    if (!saved.ok) {
      console.error('The word about the network could not be kept as seen:', saved.error);
    }
    await share();
  }

  /** Shares the plan, the window showing the code once it is shared. */
  async function share(): Promise<void> {
    starting = true;
    await app.startSharing();
    starting = false;
  }

  /** Copies the code, saying whether it could. */
  async function copyCode(): Promise<void> {
    copied = (await collaboration.copyCode()) ? 'copied' : 'failed';
  }

  /** Lets a guest edit or puts them back in read only, the choice shown staying as it was when the host refused it. */
  function chooseRight(
    participant: Participant,
    canEdit: boolean,
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    if (!collaboration.setRight(participant.id, canEdit)) {
      event.currentTarget.checked = false;
    }
  }

  /** Stops sharing and closes the window. */
  async function stopSharing(): Promise<void> {
    await collaboration.stop();
    app.closeCollaborationWindow();
  }

  /** Tells when a guest joined, or that this person is the host. */
  function roleOf(participant: Participant): string {
    if (participant.isHost) {
      return text.youHost;
    }
    const joined = collaboration.joinedAt(participant.id);
    return joined === null ? '' : fillMessage(text.joinedAt, { time: timeFormat.format(joined) });
  }
</script>

<dialog
  class="share"
  aria-labelledby="share-title"
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
  {#if app.collaborationWindow === 'share'}
    <div class="head">
      <h2 id="share-title">{fillMessage(text.shareTitle, { plan: project.name })}</h2>
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
    <div class="body">
      {#if sharing === null}
        <p class="intro">{text.setupIntro}</p>
      {:else}
        <section class="code-part" aria-labelledby="share-code-title">
          <h3 id="share-code-title">{text.codeLabel}</h3>
          <div class="code-row">
            <output class="code" aria-labelledby="share-code-title">
              {#each sharing.code.split('') as character, index (index)}
                <span class="character">{character}</span>
              {/each}
            </output>
            <button
              type="button"
              class="button"
              onclick={() => {
                void copyCode();
              }}>{copied === 'copied' ? text.copied : text.copy}</button
            >
          </div>
          {#if copied === 'failed'}
            <p class="message error">{text.copyFailed}</p>
          {/if}
          <p class="hint">{text.codeHint}</p>
          {#if sharing.addresses.length === 0}
            <p class="message warning">{text.noAddress}</p>
          {:else}
            <p class="hint">
              {text.addressIntro}
              <span class="address"
                >{fillMessage(text.address, {
                  addresses: sharing.addresses.join(', '),
                  port: String(sharing.port),
                })}</span
              >
            </p>
          {/if}
          {#if settings !== null && sharing.port !== settings.port}
            <p class="hint">
              {fillMessage(text.portInUse, {
                wanted: String(settings.port),
                port: String(sharing.port),
              })}
            </p>
          {/if}
        </section>
        <section class="people" aria-labelledby="share-people-title">
          <h3 id="share-people-title">{text.people}</h3>
          <ul>
            {#each collaboration.participants as participant (participant.id)}
              <li class="person">
                <PersonBadge
                  name={participant.name}
                  color={participant.color}
                  locale={app.locale}
                />
                <span class="who">
                  {participant.name}
                  <small>{roleOf(participant)}</small>
                </span>
                {#if participant.isHost}
                  <span class="right">{text.canEdit}</span>
                {:else}
                  <div
                    class="segments"
                    role="radiogroup"
                    aria-label={fillMessage(text.rightOf, { name: participant.name })}
                  >
                    {#each [false, true] as canEdit (canEdit)}
                      <label class={['segment', { chosen: participant.canEdit === canEdit }]}>
                        <input
                          type="radio"
                          name={`right-${participant.id}`}
                          checked={participant.canEdit === canEdit}
                          onchange={(event) => {
                            chooseRight(participant, canEdit, event);
                          }}
                        />
                        {canEdit ? text.canEdit : text.readOnlyRight}
                      </label>
                    {/each}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
          <p class="hint">{text.newcomers}</p>
        </section>
      {/if}
      <label class="field">
        <span>{text.name}</span>
        <input
          id="share-name"
          bind:value={nameDraft}
          maxlength={MAX_PARTICIPANT_NAME_LENGTH}
          autocomplete="off"
          onchange={() => {
            void commitName();
          }}
        />
        {#if nameError !== null}
          <span class="message error">{nameError}</span>
        {:else}
          <small>{text.nameHint}</small>
        {/if}
      </label>
      <details class="network">
        <summary>{text.network}</summary>
        <label class="field">
          <span>{text.port}</span>
          <input
            id="share-port"
            type="number"
            min={FIRST_PORT}
            max={LAST_PORT}
            bind:value={portDraft}
            onchange={() => {
              void commitPort();
            }}
          />
          {#if portError !== null}
            <span class="message error">{portError}</span>
          {:else}
            <small>{fillMessage(text.portHint, { port: String(DEFAULT_COLLABORATION_PORT) })}</small
            >
          {/if}
        </label>
      </details>
      {#if failure !== null}
        <p class="message error" role="alert">{failure}</p>
      {/if}
    </div>
    <div class="foot">
      {#if sharing === null}
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
          disabled={starting}
          onclick={() => {
            void start();
          }}>{starting ? text.sharing : text.startSharing}</button
        >
      {:else}
        <button
          type="button"
          class="button"
          onclick={() => {
            void stopSharing();
          }}>{text.stopSharing}</button
        >
        <button
          type="button"
          class="button primary"
          onclick={() => {
            app.closeCollaborationWindow();
          }}>{text.done}</button
        >
      {/if}
    </div>
  {/if}
  <ConfirmDialog
    question={askingFirewall
      ? {
          title: text.firewallTitle,
          body: text.firewallBody,
          confirm: text.continue,
          danger: false,
        }
      : null}
    titleId="firewall-title"
    cancel={text.cancel}
    confirmed={() => {
      void firewallSeen();
    }}
    dismissed={() => {
      askingFirewall = false;
    }}
  />
</dialog>

<style>
  .share {
    width: min(520px, calc(100% - 32px));
    max-height: calc(100% - 64px);
    padding: 0;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: calc(var(--radius) + 4px);
  }

  .share[open] {
    display: flex;
    flex-direction: column;
  }

  .share::backdrop {
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
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-6);
    overflow: auto;
  }

  .intro,
  .hint {
    margin: 0;
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  .code-part {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .code-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .code {
    display: flex;
    gap: var(--space-1);
  }

  .character {
    width: 36px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    font-weight: 600;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .address {
    color: var(--color-text);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .people ul {
    margin: 0 0 var(--space-2);
    padding: 0;
    list-style: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .person {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
  }

  .person + .person {
    border-top: 1px solid var(--color-border);
  }

  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    font-weight: 500;
  }

  .who small,
  .field small {
    font-size: 12px;
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .right {
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  .segments {
    display: flex;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .segment {
    padding: var(--space-1) var(--space-2);
    font-size: var(--font-size-small);
    cursor: pointer;
  }

  .segment input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .segment.chosen {
    color: var(--color-action-text);
    background: var(--color-action);
  }

  .segment:has(input:focus-visible) {
    outline: 2px solid var(--color-focus);
    outline-offset: -2px;
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

  .network summary {
    font-size: var(--font-size-small);
    font-weight: 500;
    cursor: pointer;
  }

  .network .field {
    margin-top: var(--space-2);
  }

  .message {
    margin: 0;
    font-size: var(--font-size-small);
    font-weight: 400;
  }

  .message.error {
    color: var(--color-error);
  }

  .message.warning {
    color: var(--color-warning);
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
