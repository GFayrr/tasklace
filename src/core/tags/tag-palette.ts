import type { Tag, TagId } from '../model/project';

export const TAG_PALETTE: readonly [string, ...string[]] = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
  '#c000f8',
  '#a00070',
  '#884800',
  '#a090f8',
];

const DEFAULT_TAG_NAMES: readonly string[] = [
  'Design',
  'Development',
  'Testing',
  'Deployment',
  'Documentation',
];

/** Builds the category tags every new project starts with, each with its own palette color. */
export function createDefaultTags(createId: () => TagId): Tag[] {
  return DEFAULT_TAG_NAMES.map((name, index) => ({
    id: createId(),
    name,
    color: nextPaletteColor(index),
    representsPersonOrTeam: false,
  }));
}

/** Returns the palette color proposed for the tag created at a given position, cycling past the end. */
export function nextPaletteColor(tagCount: number): string {
  return TAG_PALETTE[tagCount % TAG_PALETTE.length] ?? TAG_PALETTE[0];
}
