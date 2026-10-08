import type { TagPattern } from '../../core/tags/tag-appearance';

export const PATTERN_TILE_SIZE = 8;

const PATTERN_INK = 'rgba(0, 0, 0, 0.35)';
const PATTERN_LINE_WIDTH = 1.5;
const DOT_RADIUS = 1.2;
const HALF = 2;

/** Draws one tile of a pattern that repeats over the bars of a tag, so that tags of similar colors stay apart. */
export function drawPatternTile(context: CanvasRenderingContext2D, pattern: TagPattern): void {
  const size = PATTERN_TILE_SIZE;
  const middle = size / HALF;
  context.clearRect(0, 0, size, size);
  context.strokeStyle = PATTERN_INK;
  context.fillStyle = PATTERN_INK;
  context.lineWidth = PATTERN_LINE_WIDTH;
  context.beginPath();
  if (pattern === 'dots') {
    context.arc(middle, middle, DOT_RADIUS, 0, Math.PI * HALF);
    context.fill();
    return;
  }
  if (pattern === 'diagonal' || pattern === 'crossHatch') {
    context.moveTo(0, size);
    context.lineTo(size, 0);
  }
  if (pattern === 'reverseDiagonal' || pattern === 'crossHatch') {
    context.moveTo(0, 0);
    context.lineTo(size, size);
  }
  if (pattern === 'horizontal') {
    context.moveTo(0, middle);
    context.lineTo(size, middle);
  }
  if (pattern === 'vertical') {
    context.moveTo(middle, 0);
    context.lineTo(middle, size);
  }
  context.stroke();
}

/** Creates a cache that draws each pattern once and turns it into a repeating canvas pattern, telling when a pattern cannot be drawn so that the bar stays plain. */
export function createPatternCache(
  createTile: () => HTMLCanvasElement,
  target: () => CanvasRenderingContext2D | null,
  failed: () => void,
): (pattern: TagPattern) => CanvasPattern | null {
  const patterns = new Map<TagPattern, CanvasPattern>();
  return (pattern) => {
    const known = patterns.get(pattern);
    if (known !== undefined) {
      return known;
    }
    const tile = createTile();
    tile.width = PATTERN_TILE_SIZE;
    tile.height = PATTERN_TILE_SIZE;
    const context = tile.getContext('2d');
    if (context === null) {
      failed();
      return null;
    }
    drawPatternTile(context, pattern);
    const created = target()?.createPattern(tile, 'repeat') ?? null;
    if (created === null) {
      failed();
      return null;
    }
    patterns.set(pattern, created);
    return created;
  };
}
