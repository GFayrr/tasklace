<script lang="ts">
  import type { AppState } from '../app/app-state.svelte';
  import { fillMessage } from '../i18n/messages';
  import Icon from './Icon.svelte';
  import MenuButton, { type MenuItem } from './MenuButton.svelte';

  let { app }: { app: AppState } = $props();
  const text = $derived(app.messages.tasklace);
  const items: readonly MenuItem[] = $derived([
    {
      key: 'settings',
      label: text.settingsItem,
      ...(app.updates.version === null
        ? {}
        : { hint: fillMessage(text.version, { version: app.updates.version }) }),
      select: () => {
        app.openTasklaceSettings();
      },
    },
    {
      key: 'guide',
      label: text.guideItem,
      select: () => void app.collaboration.relay.openGuide(),
    },
  ]);
</script>

<MenuButton label={text.menu} {items} alignEnd>
  {#snippet trigger()}
    <Icon name="menu" />
  {/snippet}
</MenuButton>
