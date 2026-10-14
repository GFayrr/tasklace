export type PaperName = 'a4' | 'a3' | 'letter';

export type PaperOrientation = 'landscape' | 'portrait';

export const PAPER_NAMES: readonly PaperName[] = ['a4', 'a3', 'letter'];

export const PAPER_ORIENTATIONS: readonly PaperOrientation[] = ['landscape', 'portrait'];

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

const PORTRAIT_SIZES: Readonly<Record<PaperName, PageSize>> = {
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
  letter: { width: 612, height: 792 },
};

/** Returns the size in points of a sheet of paper laid in an orientation. */
export function pageSizeOf(paper: PaperName, orientation: PaperOrientation): PageSize {
  const portrait = PORTRAIT_SIZES[paper];
  return orientation === 'portrait' ? portrait : { width: portrait.height, height: portrait.width };
}
