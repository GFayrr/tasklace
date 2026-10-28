<script lang="ts">
  import type { Participant } from '../../core/collaboration/participants';
  import {
    DEFAULT_COLLABORATION_PORT,
    FIRST_PORT,
    isPort,
    LAST_PORT,
  } from '../../core/collaboration/ports';
  import { MAX_PARTICIPANT_NAME_LENGTH } from '../../core/limits';
  import { hostLabelOf, readRelayAddress } from '../../core/collaboration/relay/relay-link';
  import { successionQueue } from '../../core/collaboration/succession';
  import type { Project } from '../../core/model/project';
  import type { AppState } from '../app/app-state.svelte';
  import { collaborationFailureText, relayFailureText } from '../collaboration/collaboration-text';
  import type { RelayLinkKind } from '../../preload/bridge-contract';
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
  let where = $state<'network' | 'relay'>('network');
  let addressDraft = $state('');
  let addressError = $state<string | null>(null);
  let guideFailed = $state(false);
  let linkCopied = $state<RelayLinkKind | 'failed' | null>(null);
  let askingNewLinks = $state(false);
  let newLinksMade = $state(false);
  let newLinksFailure = $state<string | null>(null);

  const text = $derived(app.messages.collaboration);
  const collaboration = $derived(app.collaboration);
  const sharing = $derived(
    collaboration.mode.kind === 'hosting' ? collaboration.mode.sharing : null,
  );
  const settings = $derived(collaboration.settings);
  const successor = $derived(successionQueue(collaboration.participants)[0]);
  const timeFormat = $derived(
    new Intl.DateTimeFormat(app.locale, { hour: 'numeric', minute: '2-digit' }),
  );
  const relay = $derived(collaboration.relay);
  const relayText = $derived(app.messages.relay);
  const links = $derived(relay.links);
  const typedRelay = $derived.by(() => {
    const address = readRelayAddress(addressDraft);
    return address.ok ? hostLabelOf(address.value) : addressDraft.trim();
  });
  const failure = $derived.by(() => {
    const shareFailure = app.shareFailure;
    if (shareFailure === null) {
      return null;
    }
    return where === 'relay'
      ? relayFailureText(app.messages, shareFailure, typedRelay)
      : collaborationFailureText(app.messages, shareFailure);
  });
  const linkRows = $derived(
    links === null
      ? []
      : [
          ...(links.edit === null
            ? []
            : [
                {
                  kind: 'edit' as const,
                  label: relayText.editLink,
                  shown: links.edit,
                  hint: relayText.editLinkHint,
                  copyLabel: relayText.copyEditLink,
                },
              ]),
          {
            kind: 'view' as const,
            label: relayText.viewLink,
            shown: links.view,
            hint: relayText.viewLinkHint,
            copyLabel: relayText.copyViewLink,
          },
        ],
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
      addressDraft = collaboration.settings?.relayAddress ?? '';
      where = addressDraft === '' ? 'network' : 'relay';
      addressError = null;
      guideFailed = false;
      linkCopied = null;
      newLinksMade = false;
      newLinksFailure = null;
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

  /** Shares the plan once the name is kept, through the relay typed or on this network, telling first, a single time, that the computer may ask about the network. */
  async function start(): Promise<void> {
    if (!(await commitName())) {
      return;
    }
    if (where === 'relay') {
      await shareThroughRelay();
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

  /** Shares the plan through the relay typed, asking for its address when none is typed. */
  async function shareThroughRelay(): Promise<void> {
    if (addressDraft.trim() === '') {
      addressError = relayText.noAddress;
      return;
    }
    addressError = null;
    starting = true;
    await app.shareThroughRelay(addressDraft);
    starting = false;
  }

  /** Opens the guide that explains how to set up a relay, saying when the browser could not. */
  async function openGuide(): Promise<void> {
    guideFailed = !(await relay.openGuide());
  }

  /** Copies a link of the plan, saying which one was copied or that it could not be. */
  async function copyLink(kind: RelayLinkKind): Promise<void> {
    linkCopied = (await relay.copyLink(kind)) ? kind : 'failed';
  }

  /** Makes new links once the person confirmed, saying that they are ready or why they could not be made. */
  async function makeNewLinks(): Promise<void> {
    askingNewLinks = false;
    linkCopied = null;
    const made = await relay.makeNewLinks();
    newLinksMade = made.ok;
    newLinksFailure = made.ok
      ? null
      : relayFailureText(app.messages, made.error, relay.relay ?? '');
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
      {#if links !== null}
        <section class="links" aria-label={relayText.throughRelay}>
          {#each linkRows as row (row.kind)}
            <div class="link-part">
              <h3>{row.label}</h3>
              <div class="link-row">
                <output class="link">{row.shown}</output>
                <button
                  type="button"
                  class="button"
                  aria-label={row.copyLabel}
                  onclick={() => {
                    void copyLink(row.kind);
                  }}>{linkCopied === row.kind ? text.copied : text.copy}</button
                >
              </div>
              <p class="hint">{row.hint}</p>
            </div>
          {/each}
          {#if linkCopied === 'failed'}
            <p class="message error">{relayText.copyFailed}</p>
          {/if}
          {#if !relay.isLinkKept}
            <p class="message warning">{relayText.linkNotKept}</p>
          {/if}
        </section>
        <section class="people" aria-labelledby="share-relay-people-title">
          <h3 id="share-relay-people-title">{relayText.peopleNow}</h3>
          <ul>
            <li class="person">
              <PersonBadge name={settings?.name ?? ''} color={0} locale={app.locale} />
              <span class="who">{fillMessage(relayText.you, { name: settings?.name ?? '' })}</span>
              <span class="right">{relay.canEdit ? text.canEdit : text.readOnlyRight}</span>
            </li>
            {#each relay.others as person (person.id)}
              <li class="person">
                <PersonBadge name={person.name} color={person.color} locale={app.locale} />
                <span class="who">{person.name}</span>
                <span class="right">{person.canEdit ? text.canEdit : text.readOnlyRight}</span>
              </li>
            {/each}
          </ul>
          <p class="hint">{relayText.rightsHint}</p>
        </section>
        {#if relay.canEdit}
          <details class="new-links">
            <summary>{relayText.wrongPerson}</summary>
            <p class="hint">{relayText.newLinksBody}</p>
            <button
              type="button"
              class="button"
              onclick={() => {
                askingNewLinks = true;
              }}>{relayText.makeNewLinks}</button
            >
          </details>
          {#if newLinksMade}
            <p class="message" role="status">{relayText.newLinksMade}</p>
          {:else if newLinksFailure !== null}
            <p class="message error" role="alert">{newLinksFailure}</p>
          {/if}
        {/if}
      {:else if sharing === null}
        <div class="choices" role="radiogroup" aria-label={relayText.whereLabel}>
          {#each ['network', 'relay'] as const as way (way)}
            <label class={['choice', { chosen: where === way }]}>
              <input
                type="radio"
                name="share-where"
                checked={where === way}
                onchange={() => {
                  where = way;
                  app.clearShareFailure();
                }}
              />
              <span class="choice-title"
                >{way === 'network' ? relayText.onThisNetwork : relayText.throughRelay}</span
              >
              <small
                >{way === 'network'
                  ? relayText.onThisNetworkHint
                  : relayText.throughRelayHint}</small
              >
            </label>
          {/each}
        </div>
        {#if where === 'network'}
          <p class="intro">{text.setupIntro}</p>
        {:else}
          <label class="field">
            <span>{relayText.address}</span>
            <input
              id="share-relay-address"
              bind:value={addressDraft}
              placeholder={relayText.addressPlaceholder}
              autocomplete="off"
              spellcheck="false"
            />
            {#if addressError !== null}
              <span class="message error">{addressError}</span>
            {:else}
              <small>{relayText.addressHint}</small>
            {/if}
          </label>
          {#if settings?.relayAddress === null}
            <div class="no-relay">
              <p class="hint">{relayText.noRelay}</p>
              <button
                type="button"
                class="button"
                onclick={() => {
                  void openGuide();
                }}>{relayText.openGuide}</button
              >
              {#if guideFailed}
                <p class="message error">{relayText.guideNotOpened}</p>
              {/if}
            </div>
          {/if}
          <p class="hint">{relayText.encrypted}</p>
        {/if}
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
          {#if successor !== undefined}
            <p class="hint">{fillMessage(text.successor, { name: successor.name })}</p>
          {/if}
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
      {#if links === null && (where === 'network' || sharing !== null)}
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
              <small
                >{fillMessage(text.portHint, { port: String(DEFAULT_COLLABORATION_PORT) })}</small
              >
            {/if}
          </label>
        </details>
      {/if}
      {#if failure !== null}
        <p class="message error" role="alert">{failure}</p>
      {/if}
    </div>
    <div class="foot">
      {#if sharing === null && links === null}
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
          }}>{links === null ? text.stopSharing : text.leave}</button
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
    question={askingNewLinks
      ? {
          title: relayText.newLinksTitle,
          body: relayText.newLinksBody,
          confirm: relayText.makeNewLinks,
          danger: true,
        }
      : null}
    titleId="new-links-title"
    cancel={text.cancel}
    confirmed={() => {
      void makeNewLinks();
    }}
    dismissed={() => {
      askingNewLinks = false;
    }}
  />
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

  .choices {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }

  .choice {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .choice input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .choice.chosen {
    border-color: var(--color-action);
    box-shadow: inset 0 0 0 1px var(--color-action);
  }

  .choice:has(input:focus-visible) {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  .choice-title {
    font-weight: 600;
  }

  .choice small {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .no-relay {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .links {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .link-part {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .link-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .link {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    overflow: hidden;
    font-size: var(--font-size-small);
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .new-links {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .new-links summary {
    font-size: var(--font-size-small);
    font-weight: 500;
    cursor: pointer;
  }

  .new-links .hint {
    margin: var(--space-2) 0;
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
