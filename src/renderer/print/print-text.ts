import { MIN_TEXT_POINTS, TEXT_WEIGHTS, type TextWeight } from '../../core/print/print-document';
import { PRINT_FONT_FAMILY } from '../../core/print/print-svg';

export type MeasureText = (text: string, size: number, weight: TextWeight) => number;

const ELLIPSIS = '…';
const PIXELS_PER_POINT = 4 / 3;
const HALF = 2;

/** Creates a measure of the width in points of a text written in Jost, from a canvas context of the page whose fonts are loaded. */
export function createCanvasMeasure(context: CanvasRenderingContext2D): MeasureText {
  return (text, size, weight) => {
    context.font = `${String(weight)} ${String(size * PIXELS_PER_POINT)}px ${PRINT_FONT_FAMILY}`;
    return context.measureText(text).width / PIXELS_PER_POINT;
  };
}

/** Waits until the page has loaded the printed font in every weight a printed page uses, then returns a measure of texts written with it, or null when the page cannot measure text. */
export async function pageMeasure(page: Document): Promise<MeasureText | null> {
  const context = page.createElement('canvas').getContext('2d');
  if (context === null) {
    return null;
  }
  const size = MIN_TEXT_POINTS * PIXELS_PER_POINT;
  await Promise.all(
    TEXT_WEIGHTS.map((weight) =>
      page.fonts.load(`${String(weight)} ${String(size)}px ${PRINT_FONT_FAMILY}`),
    ),
  );
  return createCanvasMeasure(context);
}

/** Shortens a text with an ellipsis so that it fits a width, keeping whole characters, or returns an empty text when not even the ellipsis fits. */
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
  const characters = Array.from(text);
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
