<script lang="ts">
  import type { PresentPerson } from '../collaboration/collaboration-state.svelte';
  import { initialsOf } from '../collaboration/collaboration-text';
  import { fillMessage } from '../i18n/messages';
  import { personColorOf } from '../theme/person-colors';

  interface Props {
    readonly people: readonly PresentPerson[];
    readonly locale: string;
    readonly limit: number;
    readonly more: string;
  }

  let { people, locale, limit, more }: Props = $props();
  const shown = $derived(people.slice(0, limit));
  const hidden = $derived(people.length - shown.length);
</script>

<span class="faces" aria-hidden="true">
  {#each shown as person (person.id)}
    <span class="face" style:background-color={personColorOf(person.color)}
      >{initialsOf(person.name, locale)}</span
    >
  {/each}
  {#if hidden > 0}
    <span class="face more">{fillMessage(more, { count: String(hidden) })}</span>
  {/if}
</span>

<style>
  .faces {
    display: inline-flex;
    flex-shrink: 0;
  }

  .face {
    width: 22px;
    height: 22px;
    flex: none;
    display: inline-grid;
    place-items: center;
    margin-left: -6px;
    font-size: 10px;
    font-weight: 600;
    color: var(--color-action-text);
    border: 2px solid var(--color-surface);
    border-radius: 50%;
  }

  .face:first-child {
    margin-left: 0;
  }

  .face.more {
    color: var(--color-text);
    background: var(--color-panel);
  }
</style>
