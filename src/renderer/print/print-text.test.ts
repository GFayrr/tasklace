import { describe, expect, it, vi } from 'vitest';
import { recordingCanvas } from '../plan/testing/recording-canvas';
import { createCanvasMeasure, fitText, pageMeasure, type MeasureText } from './print-text';

const CHARACTER_WIDTH = 6;

/** Measures a text at a fixed width per character. */
const measure: MeasureText = (text) => Array.from(text).length * CHARACTER_WIDTH;

describe('fitText', () => {
  it('keeps a text that fits', () => {
    expect(fitText('Survey', 36, 10, 400, measure)).toBe('Survey');
  });

  it('shortens a text with an ellipsis to the most characters that fit', () => {
    expect(fitText('Literature review', 48, 10, 400, measure)).toBe('Literat…');
    expect(fitText('Literature review', 47, 10, 400, measure)).toBe('Litera…');
  });

  it('drops the spaces before the ellipsis and never cuts a character beyond Latin in half', () => {
    expect(fitText('Write the report', 36, 10, 400, measure)).toBe('Write…');
    expect(fitText('😀😀😀😀', 18, 10, 400, measure)).toBe('😀😀…');
  });

  it('returns an empty text when not even the ellipsis fits', () => {
    expect(fitText('Survey', 5, 10, 400, measure)).toBe('');
  });

  it('measures with the size and weight asked for', () => {
    const sized = vi.fn<MeasureText>((text, size) => text.length * size);
    fitText('ab', 100, 12, 600, sized);
    expect(sized).toHaveBeenCalledWith('ab', 12, 600);
  });
});

describe('createCanvasMeasure', () => {
  it('measures in points with the printed font at the size and weight asked for', () => {
    const { context, calls } = recordingCanvas();
    const fonts: string[] = [];
    const watched = new Proxy(context, {
      set: (target, key, value: unknown) => {
        if (key === 'font') {
          fonts.push(String(value));
        }
        return Reflect.set(target, key, value);
      },
    });
    const width = createCanvasMeasure(watched)('Writing', 10, 600);
    expect(fonts).toEqual(['600 13.333333333333332px Jost']);
    expect(calls.filter((call) => call.name === 'measureText').map((call) => call.args)).toEqual([
      ['Writing'],
    ]);
    expect(width).toBeCloseTo((7 * 6 * 3) / 4, 9);
  });
});

describe('pageMeasure', () => {
  it('gives no measure when the page cannot draw on a canvas', async () => {
    const page = { createElement: () => ({ getContext: () => null }) } as unknown as Document;
    expect(await pageMeasure(page)).toBeNull();
  });

  it('loads the printed font in each weight before measuring', async () => {
    const { context } = recordingCanvas();
    const load = vi.fn(() => Promise.resolve([]));
    const page = {
      createElement: () => ({ getContext: () => context }),
      fonts: { load },
    } as unknown as Document;
    const measured = await pageMeasure(page);
    expect(load.mock.calls).toEqual([
      ['400 13.333333333333332px Jost'],
      ['500 13.333333333333332px Jost'],
      ['600 13.333333333333332px Jost'],
    ]);
    expect(measured?.('ab', 10, 400)).toBeCloseTo(9, 9);
  });

  it('fails when the font cannot be loaded', async () => {
    const { context } = recordingCanvas();
    const failure = new Error('Font refused');
    const page = {
      createElement: () => ({ getContext: () => context }),
      fonts: { load: () => Promise.reject(failure) },
    } as unknown as Document;
    await expect(pageMeasure(page)).rejects.toBe(failure);
  });
});
