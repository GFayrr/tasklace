<script lang="ts">
  import type { Tag, TagId } from '../../core/model/project';
  import { pixels } from './css-length';

  interface Props {
    readonly tags: readonly Tag[];
    readonly value: TagId | null;
    readonly anchor: DOMRect;
    readonly label: string;
    readonly noTag: string;
    readonly choose: (tagId: TagId | null) => void;
    readonly cancel: () => void;
  }

  let { tags, value, anchor, label, noTag, choose, cancel }: Props = $props();

  const GAP_PIXELS = 2;
  const options = $derived([
    { id: null, name: noTag, color: null },
    ...tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
  ]);
  let active = $derived(
    Math.max(
      0,
      options.findIndex((option) => option.id === value),
    ),
  );
  let list: HTMLUListElement | undefined = $state();

  $effect(() => {
    list?.focus();
  });

  /** Returns the identifier of the element showing an option. */
  function optionId(index: number): string {
    return `tag-option-${String(index)}`;
  }

  /** Moves through the options with the arrow keys, chooses with Enter and gives up with Escape or Tab. */
  function listKey(event: KeyboardEvent): void {
    const moves: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      active = Math.min(options.length - 1, Math.max(0, active + move));
      list?.querySelector(`#${optionId(active)}`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[active]?.id ?? null);
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      cancel();
    }
  }

  /** Gives up when the pointer is pressed outside the list. */
  function closeOutside(event: PointerEvent): void {
    if (event.target instanceof Node && list?.contains(event.target) !== true) {
      cancel();
    }
  }
</script>

<svelte:window onpointerdown={closeOutside} />

<ul
  class="tag-picker"
  role="listbox"
  tabindex="-1"
  aria-label={label}
  aria-activedescendant={optionId(active)}
  style:left={pixels(anchor.left)}
  style:top={pixels(anchor.bottom + GAP_PIXELS)}
  style:min-width={pixels(anchor.width)}
  bind:this={list}
  onkeydown={listKey}
>
  {#each options as option, index (option.id ?? '')}
    <li
      id={optionId(index)}
      class="option"
      class:active={index === active}
      role="option"
      aria-selected={option.id === value}
      onpointerenter={() => (active = index)}
      onclick={() => {
        choose(option.id);
      }}
      onkeydown={listKey}
    >
      {#if option.color !== null}
        <span class="swatch" style:background={option.color}></span>
      {:else}
        <span class="swatch none"></span>
      {/if}
      <span>{option.name}</span>
    </li>
  {/each}
</ul>

<style>
  .tag-picker {
    position: fixed;
    z-index: 30;
    max-height: 260px;
    margin: 0;
    padding: var(--space-1);
    overflow-y: auto;
    list-style: none;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    outline: none;
  }

  .option {
    padding: 6px var(--space-2);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-radius: calc(var(--radius) - 2px);
    white-space: nowrap;
    cursor: pointer;
  }

  .option.active {
    background: var(--color-selection);
  }

  .option[aria-selected='true'] {
    font-weight: 600;
  }

  .swatch {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    border-radius: 3px;
  }

  .swatch.none {
    border: 1px solid var(--color-border);
  }
</style>
