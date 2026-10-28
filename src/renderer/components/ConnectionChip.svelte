<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import type { GuestConnection } from '../collaboration/collaboration-state.svelte';
  import type { RelayConnection } from '../collaboration/relay-state.svelte';
  import { lostText, relayEndText } from '../collaboration/collaboration-text';
  import { fillMessage } from '../i18n/messages';
  import ConnectionFace from './ConnectionFace.svelte';
  import Icon from './Icon.svelte';
  import MenuButton, { type MenuItem } from './MenuButton.svelte';

  let { app }: { app: AppState } = $props();

  const text = $derived(app.messages.collaboration);
  const collaboration = $derived(app.collaboration);
  const mode = $derived(collaboration.mode);
  const host = $derived(collaboration.hostName ?? text.theHost);
  const connection: GuestConnection = $derived(
    mode.kind === 'guest' ? mode.connection : 'connected',
  );
  const names: Readonly<Record<GuestConnection, string>> = $derived({
    connected: text.connected,
    reconnecting: text.reconnecting,
    offline: collaboration.canEdit ? text.offline : text.offlineKeptApart,
    lost: text.connectionLost,
  });
  const hints: Readonly<Record<GuestConnection, string>> = $derived({
    connected: text.sharedBy,
    reconnecting: text.reconnectingDetail,
    offline: text.reconnectingDetail,
    lost: lostText(app.messages, collaboration.lastEnd, host),
  });
  const relay = $derived(collaboration.relay);
  const relayText = $derived(app.messages.relay);
  const RELAY_DOTS: Readonly<Record<RelayConnection, GuestConnection>> = {
    connecting: 'reconnecting',
    connected: 'connected',
    reconnecting: 'reconnecting',
    offline: 'offline',
    lost: 'lost',
  };
  const relayLabels: Readonly<Record<RelayConnection, string>> = $derived({
    connecting: relayText.connecting,
    connected: relay.canEdit ? relayText.shared : relayText.readOnly,
    reconnecting: relayText.reconnecting,
    offline: relay.canEdit ? relayText.offline : relayText.offlineReadOnly,
    lost: text.connectionLost,
  });
  const relayHint = $derived.by(() => {
    const end = relay.endOfOpenPlan;
    if (end !== null) {
      return relayEndText(app.messages, end.reason, end.relay);
    }
    return relay.canEdit ? undefined : relayText.readOnlyHint;
  });
  const guestItems: readonly MenuItem[] = $derived([
    {
      key: 'leave',
      label: text.leave,
      hint: connection === 'lost' ? hints.lost : fillMessage(hints[connection], { host }),
      select: () => void collaboration.stop(),
    },
  ]);
</script>

{#snippet face()}
  <ConnectionFace {app} {connection} />
{/snippet}

{#if relay.connection !== null}
  <button
    type="button"
    class="host"
    aria-label={relayLabels[relay.connection]}
    title={relayHint}
    onclick={() => app.openShare()}
  >
    <ConnectionFace
      {app}
      connection={RELAY_DOTS[relay.connection]}
      label={relayLabels[relay.connection]}
      people={collaboration.shownPeople}
    />
  </button>
{:else if mode.kind === 'idle'}
  <button type="button" class="share" onclick={() => app.openShare()}>
    <Icon name="share" />
    <span>{text.share}</span>
  </button>
{:else if mode.kind === 'hosting'}
  <button type="button" class="host" aria-label={text.connected} onclick={() => app.openShare()}>
    <ConnectionFace {app} connection="connected" />
  </button>
{:else if mode.kind === 'guest'}
  <MenuButton label={names[connection]} items={guestItems} trigger={face} alignEnd />
{/if}

<style>
  .share {
    height: var(--control-height);
    padding: 0 var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-weight: 500;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .share:hover {
    background: var(--color-panel);
  }

  .host {
    padding: 0;
    background: none;
    border: 0;
    cursor: pointer;
  }
</style>
