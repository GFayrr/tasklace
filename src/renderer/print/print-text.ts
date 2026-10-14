import { MIN_TEXT_POINTS, TEXT_WEIGHTS, type TextWeight } from '../../core/print/print-document';
import { PRINT_FONT_FAMILY } from '../../core/print/print-svg';
import { valueAt } from '../../core/table-value';

export type MeasureText = (text: string, size: number, weight: TextWeight) => number;

const ELLIPSIS = '…';
const PIXELS_PER_POINT = 4 / 3;
const HALF = 2;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Creates a measure of the width in points of a text written in Jost Print, the static weights of printed pages, from a canvas context of the page whose fonts are loaded. */
export function createCanvasMeasure(context: CanvasRenderingContext2D): MeasureText {
  return (text, size, weight) => {
    context.font = `${String(weight)} ${String(size * PIXELS_PER_POINT)}px ${PRINT_FONT_FAMILY}`;
    return context.measureText(text).width / PIXELS_PER_POINT;
  };
}

/** Waits until the page has loaded the printed font in every weight a printed page uses, then returns a measure of texts written with it, or null when the page cannot measure text, throwing when the page declares no such font. */
export async function pageMeasure(page: Document): Promise<MeasureText | null> {
  const context = page.createElement('canvas').getContext('2d');
  if (context === null) {
    return null;
  }
  const size = MIN_TEXT_POINTS * PIXELS_PER_POINT;
  const loaded = await Promise.all(
    TEXT_WEIGHTS.map((weight) =>
      page.fonts.load(`${String(weight)} ${String(size)}px ${PRINT_FONT_FAMILY}`),
    ),
  );
  const missing = TEXT_WEIGHTS.filter((_weight, index) => valueAt(loaded, index).length === 0);
  if (missing.length > 0) {
    throw new Error(
      `The page declares no ${PRINT_FONT_FAMILY} font of weight ${missing.join(', ')}.`,
    );
  }
  return createCanvasMeasure(context);
}

/** Shortens a text with an ellipsis so that it fits a width, keeping whole characters as a reader sees them, accents and composed emoji included, or returns an empty text when not even the ellipsis fits. */
export function fitText(
  text: string,
  width: number,
  size: number,
  weight: TextWeight,
  measure: MeasureText,
): string {
  if (measure(text, size, weight) <= width) {
    return text;
  }
  const characters = Array.from(GRAPHEMES.segment(text), (part) => part.segment);
  let fitting = 0;
  let tooMany = characters.length;
  while (tooMany - fitting > 1) {
    const middle = Math.floor((fitting + tooMany) / HALF);
    const candidate = `${characters.slice(0, middle).join('').trimEnd()}${ELLIPSIS}`;
    if (measure(candidate, size, weight) <= width) {
      fitting = middle;
    } else {
      tooMany = middle;
    }
  }
  const shortened = `${characters.slice(0, fitting).join('').trimEnd()}${ELLIPSIS}`;
  return measure(shortened, size, weight) <= width ? shortened : '';
}
