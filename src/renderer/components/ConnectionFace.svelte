<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import type { GuestConnection, PresentPerson } from '../collaboration/collaboration-state.svelte';
  import Icon from './Icon.svelte';
  import PeopleFaces from './PeopleFaces.svelte';

  interface Props {
    readonly app: AppState;
    readonly connection: GuestConnection;
    readonly label?: string;
    readonly people?: readonly PresentPerson[];
  }

  let { app, connection, label, people }: Props = $props();

  const FACES_SHOWN = 3;

  const text = $derived(app.messages.collaboration);
  const labels: Readonly<Record<GuestConnection, string>> = $derived({
    connected: text.shared,
    reconnecting: text.reconnectingShort,
    offline: app.collaboration.canEdit ? text.offlineShort : text.offlineReadOnlyShort,
    lost: text.connectionLost,
  });
</script>

<span class="chip">
  <span class={['dot', connection]}></span>
  {#if connection === 'lost'}
    <span class="lost-icon"><Icon name="alert" /></span>
  {/if}
  <span class="label">{label ?? labels[connection]}</span>
  {#if connection === 'connected'}
    <PeopleFaces
      people={people ?? app.collaboration.participants}
      locale={app.locale}
      limit={FACES_SHOWN}
      more={text.moreFaces}
    />
  {/if}
</span>

<style>
  .chip {
    height: 32px;
    padding: 0 10px 0 8px;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-small);
    font-weight: 500;
    white-space: nowrap;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 999px;
  }

  .chip:hover {
    background: var(--color-panel);
  }

  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: var(--color-success);
  }

  .dot.reconnecting,
  .dot.lost {
    background: var(--color-warning);
  }

  .dot.offline {
    background: var(--color-text-secondary);
  }

  .lost-icon {
    display: inline-flex;
    color: var(--color-warning);
  }

  .lost-icon :global(.icon) {
    width: 16px;
    height: 16px;
  }

  @media (max-width: 1439px) {
    .label {
      display: none;
    }
  }
</style>
