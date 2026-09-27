import type { Tag, TagId } from '../model/project';
import { failure, success, type Result } from '../result';
import { SIMULATED_VISIONS, isHexColor, oklabDistance, toOklab } from './color-vision';
import type { LinearRgb } from './color-matrices';

export type TagPattern =
  'diagonal' | 'reverseDiagonal' | 'dots' | 'crossHatch' | 'horizontal' | 'vertical';

export const TAG_PATTERNS: readonly TagPattern[] = [
  'diagonal',
  'reverseDiagonal',
  'dots',
  'crossHatch',
  'horizontal',
  'vertical',
];

export const NORMAL_VISION_MIN_DISTANCE = 15;
export const SIMULATED_VISION_MIN_DISTANCE = 8;

export interface TagAppearance {
  readonly tagId: TagId;
  readonly color: string;
  readonly pattern: TagPattern | null;
  readonly isDistinguishable: boolean;
}

export interface TagColorError {
  readonly code: 'INVALID_TAG_COLOR';
  readonly tagId: TagId;
}

/** Gives every tag its color and, when its color could be confused with an earlier tag, a pattern. */
export function computeTagAppearances(
  tags: readonly Tag[],
  alwaysShowPatterns: boolean,
): Result<TagAppearance[], readonly TagColorError[]> {
  const errors = tags
    .filter((tag) => !isHexColor(tag.color))
    .map((tag): TagColorError => ({ code: 'INVALID_TAG_COLOR', tagId: tag.id }));
  if (errors.length > 0) {
    return failure(errors);
  }
  const looks = tags.map((tag) => looksOf(tag.color));
  const appearances: TagAppearance[] = [];
  tags.forEach((tag, index) => {
    const look = looks[index] ?? looksOf(tag.color);
    const lookalikes = appearances.filter((_earlier, earlierIndex) => {
      const earlierLook = looks[earlierIndex];
      return earlierLook !== undefined && areLooksConfusable(earlierLook, look);
    });
    appearances.push(chooseAppearance(tag, lookalikes, alwaysShowPatterns));
  });
  return success(appearances);
}

/** Tells whether two colors are too close for normal vision or for any simulated color vision. */
export function areConfusable(first: string, second: string): boolean {
  return areLooksConfusable(looksOf(first), looksOf(second));
}

interface ColorLooks {
  readonly normal: LinearRgb;
  readonly simulated: readonly LinearRgb[];
}

/** Converts a color once into OKLab for normal vision and for every simulated color vision. */
function looksOf(color: string): ColorLooks {
  return {
    normal: toOklab(color, 'normal'),
    simulated: SIMULATED_VISIONS.map((vision) => toOklab(color, vision)),
  };
}

/** Tells whether two converted colors are too close for normal vision or for any simulated color vision. */
function areLooksConfusable(first: ColorLooks, second: ColorLooks): boolean {
  if (oklabDistance(first.normal, second.normal) < NORMAL_VISION_MIN_DISTANCE) {
    return true;
  }
  return first.simulated.some((look, index) => {
    const other = second.simulated[index];
    return other !== undefined && oklabDistance(look, other) < SIMULATED_VISION_MIN_DISTANCE;
  });
}

/** Picks the first look (plain, then each pattern) that no confusable earlier tag already uses. */
function chooseAppearance(
  tag: Tag,
  lookalikes: readonly TagAppearance[],
  alwaysShowPatterns: boolean,
): TagAppearance {
  const usedPatterns = new Set(lookalikes.map((lookalike) => lookalike.pattern));
  const choices: (TagPattern | null)[] = alwaysShowPatterns
    ? [...TAG_PATTERNS]
    : [null, ...TAG_PATTERNS];
  const pattern = choices.find((choice) => !usedPatterns.has(choice));
  return {
    tagId: tag.id,
    color: tag.color,
    pattern: pattern ?? null,
    isDistinguishable: pattern !== undefined,
  };
}
