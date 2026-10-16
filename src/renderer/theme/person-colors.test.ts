import { describe, expect, it } from 'vitest';
import { PARTICIPANT_COLOR_COUNT } from '../../core/collaboration/participants';
import { colorDistance } from '../../core/tags/color-vision';
import { TAG_PALETTE } from '../../core/tags/tag-palette';
import {
  contrastRatio,
  INTERFACE_MINIMUM_RATIO,
  isThemeHexColor,
  TEXT_MINIMUM_RATIO,
} from './contrast';
import { PERSON_COLORS, personColorOf } from './person-colors';
import { SAND_GRAPHITE } from './sand-graphite';

const MIN_PERSON_COLOR_DISTANCE = 9;

describe('the colors of people', () => {
  it('gives one color to each place of the palette of people, written as six hexadecimal digits', () => {
    expect(PERSON_COLORS.length).toBe(PARTICIPANT_COLOR_COUNT);
    expect(PERSON_COLORS.every(isThemeHexColor)).toBe(true);
  });

  it('keeps white initials readable on each color, and each color visible on the surfaces of the theme', () => {
    const tooPale = PERSON_COLORS.filter(
      (color) =>
        contrastRatio(SAND_GRAPHITE.actionText, color) < TEXT_MINIMUM_RATIO ||
        [SAND_GRAPHITE.background, SAND_GRAPHITE.surface, SAND_GRAPHITE.selection].some(
          (surface) => contrastRatio(color, surface) < INTERFACE_MINIMUM_RATIO,
        ),
    );
    expect(tooPale).toEqual([]);
  });

  it('keeps every two colors of people apart, and none equal to a color of the tags', () => {
    const close = PERSON_COLORS.flatMap((first, index) =>
      PERSON_COLORS.slice(index + 1)
        .filter((second) => colorDistance(first, second, 'normal') < MIN_PERSON_COLOR_DISTANCE)
        .map((second) => [first, second]),
    );
    const tags = new Set(TAG_PALETTE.map((color) => color.toUpperCase()));
    expect([close, PERSON_COLORS.filter((color) => tags.has(color))]).toEqual([[], []]);
  });

  it('gives the color of a place, and throws for a place outside the palette', () => {
    expect(personColorOf(2)).toBe('#1D7A5A');
    expect(() => personColorOf(PARTICIPANT_COLOR_COUNT)).toThrow(
      'No value at position 8 of a table of 8.',
    );
  });
});
