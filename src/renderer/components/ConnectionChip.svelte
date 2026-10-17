<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import type { GuestConnection } from '../collaboration/collaboration-state.svelte';
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
    lost: text.connectionLostDetail,
  });
  const guestItems: readonly MenuItem[] = $derived([
    {
      key: 'leave',
      label: text.leave,
      hint: fillMessage(hints[connection], { host }),
      select: () => void collaboration.stop(),
    },
  ]);
</script>

{#snippet face()}
  <ConnectionFace {app} {connection} />
{/snippet}

{#if mode.kind === 'idle'}
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
