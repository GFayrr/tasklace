import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrintOrder } from '../../core/print/print-document';
import type { CheckedPrintDocument } from '../../core/print/read-print-document';
import { failure } from '../../core/result';
import { checkedOrThrow } from '../../core/testing/print-arbitrary';
import { runFileTask } from '../file-tasks';
import { printFontsIn } from '../pdf-export';
import { MissingCharacter, TooLargePdf, TooManyPatternTiles, writeDirectPdf } from './direct-pdf';

const pdfLimit = vi.hoisted(() => ({ bytes: null as number | null }));

vi.mock('../../core/limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/limits')>();
  return {
    ...original,
    MAX_PRINT_PATTERN_TILES: 4,
    get MAX_PDF_BYTES() {
      return pdfLimit.bytes ?? original.MAX_PDF_BYTES;
    },
  };
});

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

describe('the tiles of the patterns of a lighter PDF', () => {
  it('draws the tiles the document needs within the limit, over all its pages', async () => {
    const pdf = await writeDirectPdf(patterned(0, 16), FONTS);
    expect(Buffer.from(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('refuses a document whose patterns need more tiles than the limit', async () => {
    await expect(writeDirectPdf(patterned(0, 24), FONTS)).rejects.toThrow(
      new TooManyPatternTiles(4),
    );
  });

  it('counts no tile for a pattern outside the page, which would not show', async () => {
    const pdf = await writeDirectPdf(patterned(20_000, 12_000), FONTS);
    expect(Buffer.from(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('turns a document refused for its patterns into a PDF too large, logged, in the file worker task', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await runFileTask({ kind: 'writeDirectPdf', document: patterned(0, 24), fonts: FONTS }),
      ).toEqual(failure({ code: 'TOO_LARGE' }));
      expect(logged.mock.calls).toEqual([
        ['The lighter PDF was refused:', new TooManyPatternTiles(4)],
      ]);
    } finally {
      logged.mockRestore();
    }
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
