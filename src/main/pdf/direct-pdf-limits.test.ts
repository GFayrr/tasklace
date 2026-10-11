import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrintDocument, PrintOrder } from '../../core/print/print-document';
import { failure } from '../../core/result';
import { runFileTask } from '../file-tasks';
import { printFontsIn } from '../pdf-export';
import { TooManyPatternTiles, writeDirectPdf } from './direct-pdf';

vi.mock('../../core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/limits')>()),
  MAX_PRINT_PATTERN_TILES: 4,
}));

const FONTS = printFontsIn(join(import.meta.dirname, '../../renderer/public/fonts'));

/** Builds a document whose page covers a rectangle with a pattern. */
function patterned(x: number, width: number): PrintDocument {
  const order: PrintOrder = {
    kind: 'pattern',
    shape: { kind: 'rect', x, y: 0, width, height: 8 },
    pattern: 'dots',
  };
  return { paper: 'a4', orientation: 'landscape', title: 'Plan', pages: [[order], [order]] };
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

  it('gives back the PDF made in the file worker task', async () => {
    const made = await runFileTask({
      kind: 'writeDirectPdf',
      document: patterned(0, 8),
      fonts: FONTS,
    });
    expect(made.ok && made.value.kind).toBe('directPdf');
  });
});
