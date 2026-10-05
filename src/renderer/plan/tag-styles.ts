import type { Project, TagId } from '../../core/model/project';
import { computeTagAppearances, type TagPattern } from '../../core/tags/tag-appearance';

export interface TagStyle {
  readonly color: string;
  readonly pale: string;
  readonly pattern: TagPattern | null;
  readonly isDistinguishable: boolean;
}

const PALE_MIX = 0.55;
const HEX_RADIX = 16;
const CHANNEL_MAXIMUM = 255;
const CHANNEL_DIGITS = 2;
const CHANNEL_OFFSETS = [1, 3, 5] as const;

/** Gives every tag of a project the color, pale color and pattern of its bars, and whether it can be told apart from the other tags. */
export function tagStylesOf(project: Project | null): ReadonlyMap<TagId, TagStyle> {
  const styles = new Map<TagId, TagStyle>();
  const appearances =
    project === null
      ? null
      : computeTagAppearances(project.tags, project.options.alwaysShowPatterns);
  if (appearances?.ok !== true) {
    return styles;
  }
  for (const appearance of appearances.value) {
    styles.set(appearance.tagId, {
      color: appearance.color,
      pale: paleColor(appearance.color),
      pattern: appearance.pattern,
      isDistinguishable: appearance.isDistinguishable,
    });
  }
  return styles;
}

/** Mixes a color written as six hexadecimal digits with white. */
export function paleColor(color: string, whiteShare = PALE_MIX): string {
  const channels = CHANNEL_OFFSETS.map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + CHANNEL_DIGITS), HEX_RADIX);
    const mixed = Math.round(value + (CHANNEL_MAXIMUM - value) * whiteShare);
    return mixed.toString(HEX_RADIX).padStart(CHANNEL_DIGITS, '0');
  });
  return `#${channels.join('')}`;
}
