import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrintOrder } from '../../core/print/print-document';
import type { CheckedPrintDocument } from '../../core/print/read-print-document';
import { failure } from '../../core/result';
import { checkedOrThrow } from '../../core/testing/print-arbitrary';
import { runFileTask } from '../file-tasks';
import { printFontsIn } from '../pdf-export';
import { MissingCharacter, TooLargePdf, writeDirectPdf } from './direct-pdf';

const pdfLimit = vi.hoisted(() => ({ bytes: null as number | null }));

vi.mock('../../core/limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/limits')>();
  return {
    ...original,
    get MAX_PDF_BYTES() {
      return pdfLimit.bytes ?? original.MAX_PDF_BYTES;
    },
  };
});

const CURVE_OPERATOR = / c\n/g;
const CURVES_PER_CIRCLE = 4;
const FONTS = printFontsIn(join(import.meta.dirname, '../../renderer/public/fonts'));

/** Builds a document whose page covers a rectangle with a pattern. */
function patterned(x: number, width: number): CheckedPrintDocument {
  const order: PrintOrder = {
    kind: 'pattern',
    shape: { kind: 'rect', x, y: 0, width, height: 8 },
    pattern: 'dots',
  };
  return checkedOrThrow({
    paper: 'a4',
    orientation: 'landscape',
    title: 'Plan',
    pages: [[order], [order]],
  });
}

/** Counts the dots of patterns an uncompressed PDF draws, each dot being a circle of four curves. */
async function dotsDrawn(document: CheckedPrintDocument): Promise<number> {
  const pdf = Buffer.from(await writeDirectPdf(document, FONTS, false)).toString('latin1');
  return (pdf.match(CURVE_OPERATOR) ?? []).length / CURVES_PER_CIRCLE;
}

describe('the tiles and the size of a lighter PDF', () => {
  it('draws the tiles the document needs, over all its pages', async () => {
    expect(await dotsDrawn(patterned(0, 16))).toBe(4);
  });

  it('draws no tile for a pattern outside the page, which would not show', async () => {
    expect(await dotsDrawn(patterned(20_000, 12_000))).toBe(0);
  });

  it('writes a PDF of exactly the largest size allowed, and refuses one byte more without keeping its bytes', async () => {
    const size = (await writeDirectPdf(patterned(0, 8), FONTS)).length;
    pdfLimit.bytes = size;
    try {
      expect((await writeDirectPdf(patterned(0, 8), FONTS)).length).toBe(size);
      pdfLimit.bytes = size - 1;
      await expect(writeDirectPdf(patterned(0, 8), FONTS)).rejects.toThrow(
        new TooLargePdf(size - 1),
      );
    } finally {
      pdfLimit.bytes = null;
    }
  });

  it('turns a lighter PDF larger than allowed into a PDF too large, logged, in the file worker task', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pdfLimit.bytes = 1;
    try {
      expect(
        await runFileTask({ kind: 'writeDirectPdf', document: patterned(0, 8), fonts: FONTS }),
      ).toEqual(failure({ code: 'TOO_LARGE' }));
      expect(logged.mock.calls).toEqual([['The lighter PDF was refused:', new TooLargePdf(1)]]);
    } finally {
      pdfLimit.bytes = null;
      logged.mockRestore();
    }
  });

  it('refuses a character the printed font lacks, in the file worker task, rather than writing a blank', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const document = checkedOrThrow({
      ...patterned(0, 8),
      pages: [
        [
          {
            kind: 'text',
            x: 10,
            y: 20,
            text: 'Plan 漢',
            size: 10,
            weight: 400,
            color: '#000000',
            align: 'start',
          },
        ],
      ],
    });
    try {
      expect(await runFileTask({ kind: 'writeDirectPdf', document, fonts: FONTS })).toEqual(
        failure({ code: 'MISSING_CHARACTERS' }),
      );
      expect(logged.mock.calls).toEqual([
        ['The lighter PDF was refused:', new MissingCharacter('漢')],
      ]);
      expect(new MissingCharacter('漢').message).toBe('The printed font has no glyph for U+6F22.');
    } finally {
      logged.mockRestore();
    }
  });

  it('gives back the PDF made in the file worker task', async () => {
    const made = await runFileTask({
      kind: 'writeDirectPdf',
      document: patterned(0, 8),
      fonts: FONTS,
    });
    expect(made.ok && made.value.kind).toBe('directPdf');
  });
});
