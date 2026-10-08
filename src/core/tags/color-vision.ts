import {
  LMS_TO_OKLAB,
  LUMINANCE_WEIGHTS,
  MACHADO_2009,
  RGB_TO_LMS,
  type LinearRgb,
  type Matrix,
} from './color-matrices';

export type ColorVision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'grayscale';

export const SIMULATED_VISIONS: readonly ColorVision[] = [
  'protanopia',
  'deuteranopia',
  'tritanopia',
  'grayscale',
];

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HEX_RADIX = 16;
const CHANNEL_MAX = 255;
const RED_OFFSET = 1;
const GREEN_OFFSET = 3;
const BLUE_OFFSET = 5;
const CHANNEL_LENGTH = 2;
const SRGB_LINEAR_THRESHOLD = 0.04045;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_GAMMA = 2.4;
const DISTANCE_SCALE = 100;
/** Tells whether a value is a color written as #RRGGBB. */
export function isHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value);
}

/** Converts a #RRGGBB color into OKLab coordinates as seen with a given color vision. */
export function toOklab(hexColor: string, vision: ColorVision = 'normal'): LinearRgb {
  const [longCone, mediumCone, shortCone] = multiply(
    RGB_TO_LMS,
    simulate(toLinearRgb(hexColor), vision),
  );
  return multiply(LMS_TO_OKLAB, [Math.cbrt(longCone), Math.cbrt(mediumCone), Math.cbrt(shortCone)]);
}

/** Measures how different two colors look with a given color vision (OKLab distance × 100). */
export function colorDistance(first: string, second: string, vision: ColorVision): number {
  return oklabDistance(toOklab(first, vision), toOklab(second, vision));
}

/** Measures how different two colors already converted to OKLab look (distance × 100). */
export function oklabDistance(
  [firstL, firstA, firstB]: LinearRgb,
  [secondL, secondA, secondB]: LinearRgb,
): number {
  return DISTANCE_SCALE * Math.hypot(firstL - secondL, firstA - secondA, firstB - secondB);
}

/** Converts a #RRGGBB color into linear RGB channels between 0 and 1. */
function toLinearRgb(hexColor: string): LinearRgb {
  /** Reads one color channel of the hexadecimal color as a linear value. */
  const channel = (offset: number): number =>
    toLinearChannel(
      Number.parseInt(hexColor.slice(offset, offset + CHANNEL_LENGTH), HEX_RADIX) / CHANNEL_MAX,
    );
  return [channel(RED_OFFSET), channel(GREEN_OFFSET), channel(BLUE_OFFSET)];
}

/** Removes the sRGB gamma from one channel. */
function toLinearChannel(value: number): number {
  return value <= SRGB_LINEAR_THRESHOLD
    ? value / SRGB_LINEAR_SLOPE
    : ((value + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_GAMMA;
}

/** Transforms linear RGB channels as they would be perceived with a given color vision. */
function simulate(rgb: LinearRgb, vision: ColorVision): LinearRgb {
  if (vision === 'normal') {
    return rgb;
  }
  if (vision === 'grayscale') {
    const [luminance] = multiply([LUMINANCE_WEIGHTS, LUMINANCE_WEIGHTS, LUMINANCE_WEIGHTS], rgb);
    return [luminance, luminance, luminance];
  }
  const [red, green, blue] = multiply(MACHADO_2009[vision], rgb);
  return [clampUnit(red), clampUnit(green), clampUnit(blue)];
}

/** Multiplies a 3 × 3 matrix by a vector of three values. */
function multiply(matrix: Matrix, [x, y, z]: LinearRgb): LinearRgb {
  const [first, second, third] = matrix;
  return [
    first[0] * x + first[1] * y + first[2] * z,
    second[0] * x + second[1] * y + second[2] * z,
    third[0] * x + third[1] * y + third[2] * z,
  ];
}

/** Keeps a value between 0 and 1. */
function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}
