import {
  PATTERN_INK_OPACITY,
  PATTERN_LINE_WIDTH,
  PATTERN_TILE_SIZE,
  patternTileOf,
} from '../../core/print/pattern-tiles';
import type { TagPattern } from '../../core/tags/tag-appearance';

export { PATTERN_TILE_SIZE };

const FULL_TURN = Math.PI * 2;
const PATTERN_INK = `rgba(0, 0, 0, ${String(PATTERN_INK_OPACITY)})`;

/** Draws one tile of a pattern that repeats over the bars of a tag, so that tags of similar colors stay apart. */
export function drawPatternTile(context: CanvasRenderingContext2D, pattern: TagPattern): void {
  const tile = patternTileOf(pattern);
  context.clearRect(0, 0, PATTERN_TILE_SIZE, PATTERN_TILE_SIZE);
  context.strokeStyle = PATTERN_INK;
  context.fillStyle = PATTERN_INK;
  context.lineWidth = PATTERN_LINE_WIDTH;
  context.beginPath();
  if (tile.kind === 'dot') {
    context.arc(tile.x, tile.y, tile.radius, 0, FULL_TURN);
    context.fill();
    return;
  }
  for (const [startX, startY, endX, endY] of tile.lines) {
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
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
