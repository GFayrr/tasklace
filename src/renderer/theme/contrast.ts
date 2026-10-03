import type { Theme, ThemeColor } from './theme';

export interface ContrastPair {
  readonly foreground: ThemeColor;
  readonly background: ThemeColor;
  readonly minimum: number;
}

export interface ContrastIssue extends ContrastPair {
  readonly ratio: number;
}

const TEXT_MINIMUM_RATIO = 4.5;
const INTERFACE_MINIMUM_RATIO = 3;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HEX_RADIX = 16;
const CHANNEL_MAXIMUM = 255;
const RED_OFFSET = 1;
const GREEN_OFFSET = 3;
const BLUE_OFFSET = 5;
const CHANNEL_DIGITS = 2;
const LINEAR_THRESHOLD = 0.04045;
const LINEAR_SLOPE = 12.92;
const GAMMA_OFFSET = 0.055;
const GAMMA_SCALE = 1.055;
const GAMMA_EXPONENT = 2.4;
const RED_WEIGHT = 0.2126;
const GREEN_WEIGHT = 0.7152;
const BLUE_WEIGHT = 0.0722;
const FLARE = 0.05;

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { foreground: 'text', background: 'background', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'text', background: 'surface', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'text', background: 'panel', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'text', background: 'selection', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'textSecondary', background: 'background', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'textSecondary', background: 'surface', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'textSecondary', background: 'panel', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'actionText', background: 'action', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'actionText', background: 'actionHover', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'success', background: 'surface', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'warning', background: 'surface', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'error', background: 'surface', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'action', background: 'background', minimum: INTERFACE_MINIMUM_RATIO },
  { foreground: 'focus', background: 'background', minimum: INTERFACE_MINIMUM_RATIO },
  { foreground: 'focus', background: 'surface', minimum: INTERFACE_MINIMUM_RATIO },
  { foreground: 'bar', background: 'surface', minimum: INTERFACE_MINIMUM_RATIO },
  { foreground: 'bar', background: 'nonWorking', minimum: INTERFACE_MINIMUM_RATIO },
  { foreground: 'text', background: 'nonWorking', minimum: TEXT_MINIMUM_RATIO },
  { foreground: 'error', background: 'nonWorking', minimum: INTERFACE_MINIMUM_RATIO },
];

/** Tells whether a value is a color written as six hexadecimal digits after a hash. */
export function isThemeHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value);
}

/** Computes the WCAG 2 contrast ratio between two colors written as six hexadecimal digits. */
export function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + FLARE) / (darker + FLARE);
}

/** Lists the pairs of colors of a theme whose contrast is below the WCAG AA minimum. */
export function findContrastIssues(theme: Theme): ContrastIssue[] {
  return CONTRAST_PAIRS.flatMap((pair) => {
    const ratio = contrastRatio(theme[pair.foreground], theme[pair.background]);
    return ratio < pair.minimum ? [{ ...pair, ratio }] : [];
  });
}

/** Computes the WCAG 2 relative luminance of a color. */
function relativeLuminance(color: string): number {
  const red = linearChannel(color, RED_OFFSET);
  const green = linearChannel(color, GREEN_OFFSET);
  const blue = linearChannel(color, BLUE_OFFSET);
  return RED_WEIGHT * red + GREEN_WEIGHT * green + BLUE_WEIGHT * blue;
}

/** Reads one channel of a color and converts it to linear light. */
function linearChannel(color: string, offset: number): number {
  const value = Number.parseInt(color.slice(offset, offset + CHANNEL_DIGITS), HEX_RADIX);
  const channel = value / CHANNEL_MAXIMUM;
  return channel <= LINEAR_THRESHOLD
    ? channel / LINEAR_SLOPE
    : ((channel + GAMMA_OFFSET) / GAMMA_SCALE) ** GAMMA_EXPONENT;
}
