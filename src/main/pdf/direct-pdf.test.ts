import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PAPER_NAMES, PAPER_ORIENTATIONS, pageSizeOf } from '../../core/print/paper';
import {
  PATH_CLOSE,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  type PrintDocument,
  type PrintOrder,
} from '../../core/print/print-document';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../core/testing/arbitraries';
import { printDocumentArbitrary } from '../../core/testing/print-arbitrary';
import { printFontsIn } from '../pdf-export';
import { writeDirectPdf } from './direct-pdf';

const FONTS = printFontsIn(join(import.meta.dirname, '../../renderer/public/fonts'));
const RECT = { kind: 'rect', x: 10, y: 20, width: 30, height: 8 } as const;

/** Builds a landscape A4 document whose single page holds some orders. */
function documentOf(...orders: PrintOrder[]): PrintDocument {
  return { paper: 'a4', orientation: 'landscape', title: 'Thesis', pages: [orders] };
}

/** Writes a document as an uncompressed PDF and returns it as text, so that its operators can be read. */
async function pdfText(document: PrintDocument): Promise<string> {
  return Buffer.from(await writeDirectPdf(document, FONTS, false)).toString('latin1');
}

/** Returns the objects of an uncompressed PDF by number. */
function objectsOf(pdf: string): Map<string, string> {
  return new Map(
    [...pdf.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)].map(([, number = '', body = '']) => [
      number,
      body,
    ]),
  );
}

/** Reads the map from glyph codes to characters of a font, from its ToUnicode stream. */
function unicodeOf(objects: Map<string, string>, fontObject: string): Map<number, string> {
  const font = objects.get(fontObject) ?? '';
  const cmap = objects.get(/\/ToUnicode (\d+) 0 R/.exec(font)?.[1] ?? '') ?? '';
  const map = new Map<number, string>();
  for (const [, first = '0', codes = ''] of cmap.matchAll(
    /<([0-9a-f]{4})> <[0-9a-f]{4}> \[([^\]]*)\]/g,
  )) {
    [...codes.matchAll(/<([0-9a-f]+)>/g)].forEach(([, hex = ''], index) => {
      map.set(
        Number.parseInt(first, 16) + index,
        String.fromCodePoint(
          ...(hex.match(/.{4}/g) ?? []).map((unit) => Number.parseInt(unit, 16)),
        ),
      );
    });
  }
  return map;
}

/** Reads back every text an uncompressed PDF written by PDFKit shows, with the name of its font, in drawing order. */
function textsOf(pdf: string): { readonly font: string; readonly text: string }[] {
  const objects = objectsOf(pdf);
  const fonts = new Map<string, { readonly name: string; readonly unicode: Map<number, string> }>();
  for (const [, resource = '', object = ''] of pdf.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const name = /\/BaseFont \/[A-Z]{6}\+([\w-]+)/.exec(objects.get(object) ?? '')?.[1] ?? '';
    fonts.set(resource, { name, unicode: unicodeOf(objects, object) });
  }
  const texts: { font: string; text: string }[] = [];
  let current = fonts.get('F1');
  for (const [, resource, array = ''] of pdf.matchAll(/\/(F\d+) [\d.]+ Tf|\[([^\]]*)\] TJ/g)) {
    if (resource !== undefined) {
      current = fonts.get(resource);
      continue;
    }
    const codes = [...array.matchAll(/<([0-9a-f]+)>/g)].flatMap(
      ([, hex = '']) => hex.match(/.{4}/g) ?? [],
    );
    const text = codes
      .map((code) => current?.unicode.get(Number.parseInt(code, 16)) ?? '?')
      .join('');
    texts.push({ font: current?.name ?? '', text });
  }
  return texts;
}

/** Counts the times an operator appears at the end of a line of the content. */
function operatorCount(pdf: string, operator: string): number {
  return pdf.split('\n').filter((line) => line.endsWith(` ${operator}`) || line === operator)
    .length;
}

describe('writeDirectPdf', () => {
  it.each(
    PAPER_NAMES.flatMap((paper) =>
      PAPER_ORIENTATIONS.map((orientation) => [paper, orientation] as const),
    ),
  )(
    'writes every page of a %s %s document at the size of its paper',
    async (paper, orientation) => {
      const pdf = await pdfText({ paper, orientation, title: 'Plan', pages: [[], [], []] });
      const size = pageSizeOf(paper, orientation);
      expect(pdf.match(/\/MediaBox \[[^\]]*\]/g)).toEqual(
        Array.from(
          { length: 3 },
          () => `/MediaBox [0 0 ${String(size.width)} ${String(size.height)}]`,
        ),
      );
    },
  );

  it('starts like any PDF and names the document after its title, written by Tasklace', async () => {
    const pdf = await pdfText(documentOf());
    expect(pdf.slice(0, 5)).toBe('%PDF-');
    expect(pdf).toMatch(/\(Thesis\)/);
    expect(pdf).toMatch(/\/Producer \d+ 0 R/);
    expect(pdf.match(/\(Tasklace\)/g)).toHaveLength(2);
  });

  it('writes each text in its weight of Jost, embedded as a subset that maps back to the characters', async () => {
    const pdf = await pdfText(
      documentOf(
        {
          kind: 'text',
          x: 28,
          y: 40,
          text: 'Écrire la thèse',
          size: 16,
          weight: 600,
          color: '#1c1b19',
          align: 'start',
        },
        {
          kind: 'text',
          x: 28,
          y: 60,
          text: 'Œuvre – 50 %',
          size: 10,
          weight: 400,
          color: '#5f5b55',
          align: 'start',
        },
        {
          kind: 'text',
          x: 28,
          y: 80,
          text: 'Medium',
          size: 10,
          weight: 500,
          color: '#1c1b19',
          align: 'start',
        },
      ),
    );
    expect(textsOf(pdf)).toEqual([
      { font: 'Jost-Semi', text: 'Écrire la thèse' },
      { font: 'Jost-Book', text: 'Œuvre – 50 %' },
      { font: 'Jost-Medium', text: 'Medium' },
    ]);
    expect(pdf.match(/\/FontFile2/g)).toHaveLength(3);
    expect(pdf).not.toMatch(/Helvetica/);
  });

  it('places a text on its baseline, shifted left by its width when centered or aligned to the end', async () => {
    /** Builds a text order aligned in a given way. */
    const text = (align: 'start' | 'middle' | 'end') =>
      ({
        kind: 'text',
        x: 100,
        y: 50,
        text: 'Survey',
        size: 10,
        weight: 400,
        color: '#000000',
        align,
      }) as const;
    const pdf = await pdfText(documentOf(text('start'), text('middle'), text('end')));
    const positions = [...pdf.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].map(
      ([, x = '', y = '']) => [Number(x), Number(y)],
    );
    const [start, middle, end] = positions;
    expect(start).toEqual([100, 595.28 - 50]);
    const width = (start?.[0] ?? 0) - (end?.[0] ?? 0);
    expect(width).toBeGreaterThan(20);
    expect((start?.[0] ?? 0) - (middle?.[0] ?? 0)).toBeCloseTo(width / 2, 6);
    expect(new Set(positions.map(([, y]) => y))).toEqual(new Set([595.28 - 50]));
  });

  it('fills and strokes rectangles and paths, with their opacity and dash', async () => {
    const pdf = await pdfText(
      documentOf(
        { kind: 'fill', shape: RECT, color: '#2a78d6', opacity: 1 },
        { kind: 'fill', shape: RECT, color: '#2a78d6', opacity: 0.5 },
        {
          kind: 'stroke',
          shape: {
            kind: 'path',
            segments: [PATH_MOVE, 0, 0, PATH_LINE, 10, 5, PATH_CURVE, 1, 2, 3, 4, 5, 6, PATH_CLOSE],
          },
          color: '#5f5b55',
          opacity: 1,
          width: 1.5,
          dash: [3, 2],
        },
      ),
    );
    expect(pdf).toMatch(/scn\n\/Gs1 gs\n10 20 30 8 re\nf\n/);
    expect(pdf).toMatch(
      /\n1.5 w\n\/DeviceRGB CS\n[\d. ]+ SCN\n\/Gs\d+ gs\n\[3 2\] 0 d\n0 0 m\n10 5 l\n1 2 3 4 5 6 c\nh\nS\n\[\] 0 d/,
    );
    expect(pdf).toMatch(/\/ca 0.5/);
    expect(pdf).toMatch(/\/CA 1/);
  });

  it('keeps the orders of nested clips inside their shapes, between saves and restores', async () => {
    const pdf = await pdfText(
      documentOf({
        kind: 'clip',
        shape: RECT,
        orders: [
          {
            kind: 'clip',
            shape: RECT,
            orders: [{ kind: 'fill', shape: RECT, color: '#000000', opacity: 1 }],
          },
        ],
      }),
    );
    expect(pdf).toMatch(
      /q\n10 20 30 8 re\nW n\nq\n10 20 30 8 re\nW n\n\/DeviceRGB cs\n0 0 0 scn\n\/Gs1 gs\n10 20 30 8 re\nf\nQ\nQ/,
    );
  });

  it('draws a pattern as real lines tile by tile from the corner of the page, kept inside the shape', async () => {
    const pdf = await pdfText(
      documentOf({
        kind: 'pattern',
        shape: { kind: 'rect', x: 4, y: 4, width: 12, height: 4 },
        pattern: 'diagonal',
      }),
    );
    expect(pdf).toMatch(
      /q\n4 4 12 4 re\nW n\n1.5 w\n\/DeviceRGB CS\n0 0 0 SCN\n\/Gs1 gs\n0 8 m\n8 0 l\n8 8 m\n16 0 l\nS\nQ/,
    );
    expect(operatorCount(pdf, 'S')).toBe(1);
  });

  it('draws a dotted pattern as filled dots over every tile a path with curves reaches', async () => {
    const shape = {
      kind: 'path',
      segments: [PATH_MOVE, 0, 0, PATH_CURVE, 0, 12, 4, 12, 4, 0, PATH_CLOSE],
    } as const;
    const pdf = await pdfText(documentOf({ kind: 'pattern', shape, pattern: 'dots' }));
    expect(operatorCount(pdf, 'f')).toBe(1);
    expect(pdf.match(/ c\n/g)?.length).toBe(1 + 4 * 2);
  });

  it(
    'writes any valid document without failing, with one page for each of its pages',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(printDocumentArbitrary, async (document) => {
          const pdf = await pdfText(document);
          expect(pdf.match(/\/Type \/Page\n/g)).toHaveLength(document.pages.length);
        }),
        { numRuns: 30 },
      );
    },
  );
});
