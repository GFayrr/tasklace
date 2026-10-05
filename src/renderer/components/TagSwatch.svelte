<script lang="ts">
  import type { TagPattern } from '../../core/tags/tag-appearance';
  import { pixels } from './css-length';

  const DEFAULT_SWATCH_SIZE = 14;
  const PATTERN_CLASSES: Readonly<Record<TagPattern, string>> = {
    diagonal: 'diagonal',
    reverseDiagonal: 'reverseDiagonal',
    dots: 'dots',
    crossHatch: 'crossHatch',
    horizontal: 'horizontal',
    vertical: 'vertical',
  };

  let {
    color,
    pattern = null,
    size = DEFAULT_SWATCH_SIZE,
  }: { color: string; pattern?: TagPattern | null; size?: number } = $props();
</script>

<span
  class={['swatch', pattern === null ? null : PATTERN_CLASSES[pattern]]}
  style:background-color={color}
  style:width={pixels(size)}
  style:height={pixels(size)}
  aria-hidden="true"
></span>

<style>
  .swatch {
    flex: none;
    display: inline-block;
    border-radius: 4px;
    --ink: rgba(0, 0, 0, 0.35);
    background-size: 8px 8px;
  }

  .diagonal {
    background-image: linear-gradient(135deg, transparent 40%, var(--ink) 40% 60%, transparent 60%);
  }

  .reverseDiagonal {
    background-image: linear-gradient(45deg, transparent 40%, var(--ink) 40% 60%, transparent 60%);
  }

  .crossHatch {
    background-image:
      linear-gradient(135deg, transparent 40%, var(--ink) 40% 60%, transparent 60%),
      linear-gradient(45deg, transparent 40%, var(--ink) 40% 60%, transparent 60%);
  }

  .dots {
    background-image: radial-gradient(circle, var(--ink) 1.2px, transparent 1.6px);
  }

  .horizontal {
    background-image: linear-gradient(transparent 40%, var(--ink) 40% 60%, transparent 60%);
  }

  .vertical {
    background-image: linear-gradient(90deg, transparent 40%, var(--ink) 40% 60%, transparent 60%);
  }
</style>
