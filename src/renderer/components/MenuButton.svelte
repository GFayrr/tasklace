<script lang="ts">
  import Icon from './Icon.svelte';

  export interface MenuItem {
    readonly key: string;
    readonly label: string;
    readonly hint?: string;
    readonly select: () => void;
  }

  let { label, items }: { label: string; items: readonly MenuItem[] } = $props();
  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  /** Runs the chosen item and closes the menu. */
  function choose(item: MenuItem): void {
    open = false;
    item.select();
  }

  /** Closes the menu when the pointer or the focus goes elsewhere. */
  function closeOutside(event: Event): void {
    if (open && event.target instanceof Node && root?.contains(event.target) !== true) {
      open = false;
    }
  }

  /** Closes the menu with the Escape key. */
  function closeOnEscape(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') {
      open = false;
    }
  }
</script>

<svelte:window onpointerdown={closeOutside} onfocusin={closeOutside} onkeydown={closeOnEscape} />

<div class="menu" bind:this={root}>
  <button
    type="button"
    class="button"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <span>{label}</span>
    <Icon name="chevron" />
  </button>
  {#if open}
    <ul class="items" role="menu" aria-label={label}>
      {#each items as item (item.key)}
        <li role="none">
          <button
            type="button"
            role="menuitem"
            class="item"
            onclick={() => {
              choose(item);
            }}
          >
            {item.label}
            {#if item.hint !== undefined}
              <span class="hint">{item.hint}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .hint {
    display: block;
    color: var(--color-text-secondary);
    font-size: 0.8em;
  }

  .menu {
    position: relative;
  }

  .button {
    height: var(--control-height);
    padding: 0 var(--space-2) 0 var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-1);
    border-radius: var(--radius);
    font-weight: 500;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    cursor: pointer;
  }

  .button:hover {
    background: var(--color-panel);
  }

  .items {
    position: absolute;
    top: calc(100% + var(--space-1));
    left: 0;
    z-index: 10;
    min-width: 180px;
    margin: 0;
    padding: var(--space-1);
    list-style: none;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .item {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: calc(var(--radius) - 2px);
    cursor: pointer;
  }

  .item:hover {
    background: var(--color-selection);
  }
</style>
