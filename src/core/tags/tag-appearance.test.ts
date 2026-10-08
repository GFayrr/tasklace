import { describe, expect, it } from 'vitest';
import type { Tag } from '../model/project';
import { colorDistance, SIMULATED_VISIONS } from './color-vision';
import {
  NORMAL_VISION_MIN_DISTANCE,
  SIMULATED_VISION_MIN_DISTANCE,
  TAG_PATTERNS,
  areConfusable,
  computeTagAppearances,
} from './tag-appearance';
import { TAG_PALETTE, createDefaultTags, nextPaletteColor } from './tag-palette';

/** Builds a category tag with a given color. */
function tag(id: string, color: string): Tag {
  return { id, name: id, color, representsPersonOrTeam: false };
}

/** Computes appearances and fails the test on invalid colors. */
function appearancesOf(tags: readonly Tag[], alwaysShowPatterns = false) {
  const result = computeTagAppearances(tags, alwaysShowPatterns);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}

describe('TAG_PALETTE', () => {
  it('offers twelve different colors', () => {
    expect(new Set(TAG_PALETTE).size).toBe(12);
  });

  it('keeps neighboring colors apart for normal vision and red-green color blindness', () => {
    TAG_PALETTE.forEach((color, index) => {
      const next = TAG_PALETTE[index + 1];
      if (next === undefined) {
        return;
      }
      expect(colorDistance(color, next, 'normal')).toBeGreaterThanOrEqual(
        NORMAL_VISION_MIN_DISTANCE,
      );
      expect(colorDistance(color, next, 'protanopia')).toBeGreaterThanOrEqual(
        SIMULATED_VISION_MIN_DISTANCE,
      );
      expect(colorDistance(color, next, 'deuteranopia')).toBeGreaterThanOrEqual(
        SIMULATED_VISION_MIN_DISTANCE,
      );
    });
  });
});

describe('createDefaultTags and nextPaletteColor', () => {
  it('creates the five default categories with the first palette colors', () => {
    let counter = 0;
    const tags = createDefaultTags(() => `tag-${String((counter += 1))}`);
    expect(tags).toEqual([
      { id: 'tag-1', name: 'Design', color: TAG_PALETTE[0], representsPersonOrTeam: false },
      { id: 'tag-2', name: 'Development', color: TAG_PALETTE[1], representsPersonOrTeam: false },
      { id: 'tag-3', name: 'Testing', color: TAG_PALETTE[2], representsPersonOrTeam: false },
      { id: 'tag-4', name: 'Deployment', color: TAG_PALETTE[3], representsPersonOrTeam: false },
      { id: 'tag-5', name: 'Documentation', color: TAG_PALETTE[4], representsPersonOrTeam: false },
    ]);
  });

  it('starts over at the first color once the palette is used up', () => {
    expect(nextPaletteColor(11)).toBe(TAG_PALETTE[11]);
    expect(nextPaletteColor(12)).toBe(TAG_PALETTE[0]);
    expect(nextPaletteColor(25)).toBe(TAG_PALETTE[1]);
  });

  it.each([-1, 0.5, Number.NaN])(
    'gives the first color for the position %d, which is not a count',
    (position) => {
      expect(nextPaletteColor(position)).toBe(TAG_PALETTE[0]);
    },
  );
});

describe('areConfusable', () => {
  it('flags identical and nearly identical colors', () => {
    expect(areConfusable('#2a78d6', '#2a78d6')).toBe(true);
    expect(areConfusable('#2a78d6', '#2c7ad8')).toBe(true);
  });

  it('flags colors only red-green color-blind people would mix up', () => {
    const red = '#d03030';
    const green = '#3a9a30';
    expect(colorDistance(red, green, 'normal')).toBeGreaterThan(NORMAL_VISION_MIN_DISTANCE);
    expect(areConfusable(red, green)).toBe(true);
  });

  it('flags colors that only differ in hue when printed in grayscale', () => {
    const blue = '#3c64c8';
    const red = '#c03000';
    expect(colorDistance(blue, red, 'grayscale')).toBeLessThan(SIMULATED_VISION_MIN_DISTANCE);
    expect(colorDistance(blue, red, 'deuteranopia')).toBeGreaterThan(SIMULATED_VISION_MIN_DISTANCE);
    expect(areConfusable(blue, red)).toBe(true);
  });

  it('accepts clearly different colors for every vision', () => {
    const blue = '#2a78d6';
    const yellow = '#eda100';
    expect(SIMULATED_VISIONS.every((vision) => colorDistance(blue, yellow, vision) >= 8)).toBe(
      true,
    );
    expect(areConfusable(blue, yellow)).toBe(false);
  });
});

describe('computeTagAppearances', () => {
  it('gives no pattern to tags that are easy to tell apart', () => {
    const appearances = appearancesOf([tag('a', '#2a78d6'), tag('b', '#eda100')]);
    expect(appearances.map((appearance) => appearance.pattern)).toEqual([null, null]);
  });

  it('adds patterns to look-alike colors, in tag order, then flags the ones left over', () => {
    const tags = Array.from({ length: 8 }, (_value, index) => tag(`t${String(index)}`, '#2a78d6'));
    const appearances = appearancesOf(tags);
    expect(appearances.map((appearance) => appearance.pattern)).toEqual([
      null,
      ...TAG_PATTERNS,
      null,
    ]);
    expect(appearances.map((appearance) => appearance.isDistinguishable)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('reuses patterns between tags that do not look alike', () => {
    const appearances = appearancesOf([
      tag('blue1', '#2a78d6'),
      tag('blue2', '#2a78d6'),
      tag('yellow1', '#eda100'),
      tag('yellow2', '#eda100'),
    ]);
    expect(appearances.map((appearance) => appearance.pattern)).toEqual([
      null,
      'diagonal',
      null,
      'diagonal',
    ]);
  });

  it('gives a pattern to every tag when patterns are always shown', () => {
    const appearances = appearancesOf([tag('a', '#2a78d6'), tag('b', '#eda100')], true);
    expect(appearances.map((appearance) => appearance.pattern)).toEqual(['diagonal', 'diagonal']);
  });

  it('keeps every tag color and identifier', () => {
    expect(appearancesOf([tag('a', '#ABCDEF')])).toEqual([
      { tagId: 'a', color: '#ABCDEF', pattern: null, isDistinguishable: true },
    ]);
  });

  it('handles projects without tags', () => {
    expect(appearancesOf([])).toEqual([]);
  });

  it('rejects malformed colors and names every faulty tag', () => {
    const result = computeTagAppearances(
      [tag('ok', '#123456'), tag('named', 'red'), tag('short', '#123')],
      false,
    );
    expect(result).toEqual({
      ok: false,
      error: [
        { code: 'INVALID_TAG_COLOR', tagId: 'named' },
        { code: 'INVALID_TAG_COLOR', tagId: 'short' },
      ],
    });
  });
});
