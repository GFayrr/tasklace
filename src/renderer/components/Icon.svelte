<script lang="ts">
  export type IconName = 'plus' | 'chevron' | 'undo' | 'redo' | 'check' | 'close' | 'alert';

  let { name }: { name: IconName } = $props();
</script>

<svg
  class="icon"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'plus'}
    <path d="M12 5v14M5 12h14" />
  {:else if name === 'chevron'}
    <path d="m6 9 6 6 6-6" />
  {:else if name === 'undo'}
    <path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  {:else if name === 'redo'}
    <path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" />
  {:else if name === 'check'}
    <path d="M20 6 9 17l-5-5" />
  {:else if name === 'close'}
    <path d="M18 6 6 18M6 6l12 12" />
  {:else}
    <path d="M12 9v4M12 17h.01" /><path
      d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
    />
  {/if}
</svg>

<style>
  .icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }
</style>
