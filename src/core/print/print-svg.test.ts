import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { printDocumentArbitrary } from '../testing/print-arbitrary';
import { PATH_CLOSE, PATH_CURVE, PATH_LINE, PATH_MOVE, type PrintDocument } from './print-document';
import { escapeMarkup, printPageSvg, svgNumber } from './print-svg';

const TAG = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"<]*")*)\s*(\/?)>/g;
const TEXT_CONTENT = /<text[^>]*>([^<]*)<\/text>/g;
const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Builds a document whose pages hold the given orders. */
function documentOf(...pages: PrintDocument['pages']): PrintDocument {
  return { paper: 'a4', orientation: 'landscape', title: 'Thesis', pages };
}

/** Tells whether markup is made only of tags with quoted attributes, closed in order, and of text without a raw markup character. */
function isBalancedMarkup(markup: string): boolean {
  const open: string[] = [];
  let end = 0;
  for (const match of markup.matchAll(TAG)) {
    if (/[<>]/.test(markup.slice(end, match.index))) {
      return false;
    }
    end = match.index + match[0].length;
    const [, closing, name = '', , selfClosing] = match;
    if (closing === '/' && open.pop() !== name) {
      return false;
    }
    if (closing !== '/' && selfClosing !== '/') {
      open.push(name);
    }
  }
  return open.length === 0 && end === markup.length;
}

/** Returns the texts an SVG image writes, with their characters decoded. */
function textsOf(svg: string): string[] {
  return [...svg.matchAll(TEXT_CONTENT)].map(([, text = '']) =>
    text.replace(/&[a-z#0-9]+;/g, (entity) => ENTITIES[entity] ?? entity),
  );
}

describe('printPageSvg', () => {
  it('writes a page sized in points with each kind of order', () => {
    const svg = printPageSvg(
      documentOf([
        {
          kind: 'fill',
          shape: { kind: 'rect', x: 10, y: 20.004, width: 30, height: 40 },
          color: '#2a78d6',
          opacity: 1,
        },
        {
          kind: 'fill',
          shape: { kind: 'rect', x: 0, y: 0, width: 1, height: 1 },
          color: '#000000',
          opacity: 0.5,
        },
        {
          kind: 'stroke',
          shape: {
            kind: 'path',
            segments: [PATH_MOVE, 0, 0, PATH_LINE, 10, 5, PATH_CURVE, 1, 2, 3, 4, 5, 6, PATH_CLOSE],
          },
          color: '#1c1b19',
          opacity: 1,
          width: 1.5,
          dash: [],
        },
        {
          kind: 'stroke',
          shape: { kind: 'rect', x: 0, y: 0, width: 2, height: 2 },
          color: '#1c1b19',
          opacity: 0.25,
          width: 1,
          dash: [3, 2],
        },
        {
          kind: 'text',
          x: 28,
          y: 50,
          text: 'R&D <phase> "one" \'two\'',
          size: 10,
          weight: 600,
          color: '#1c1b19',
          align: 'middle',
        },
      ]),
      0,
    );
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="841.89pt" height="595.28pt" viewBox="0 0 841.89 595.28" font-family="Jost" xml:space="preserve">' +
        '<rect x="10" y="20" width="30" height="40" fill="#2a78d6"/>' +
        '<rect x="0" y="0" width="1" height="1" fill="#000000" fill-opacity="0.5"/>' +
        '<path d="M0 0L10 5C1 2 3 4 5 6Z" fill="none" stroke="#1c1b19" stroke-width="1.5"/>' +
        '<rect x="0" y="0" width="2" height="2" fill="none" stroke="#1c1b19" stroke-width="1" stroke-opacity="0.25" stroke-dasharray="3 2"/>' +
        '<text x="28" y="50" font-size="10" font-weight="600" fill="#1c1b19" text-anchor="middle">R&amp;D &lt;phase&gt; &quot;one&quot; &#39;two&#39;</text>' +
        '</svg>',
    );
  });

  it('defines each pattern a page uses once, with the ink of the timeline, and a clip path for each clip', () => {
    const rect = { kind: 'rect', x: 0, y: 0, width: 8, height: 8 } as const;
    const svg = printPageSvg(
      documentOf(
        [],
        [
          { kind: 'pattern', shape: rect, pattern: 'dots' },
          {
            kind: 'clip',
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            orders: [
              { kind: 'pattern', shape: rect, pattern: 'dots' },
              { kind: 'pattern', shape: rect, pattern: 'crossHatch' },
            ],
          },
          { kind: 'clip', x: 0, y: 0, width: 1, height: 1, orders: [] },
        ],
      ),
      1,
    );
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="841.89pt" height="595.28pt" viewBox="0 0 841.89 595.28" font-family="Jost" xml:space="preserve">' +
        '<defs>' +
        '<clipPath id="p1-c0"><rect x="1" y="2" width="3" height="4"/></clipPath>' +
        '<clipPath id="p1-c1"><rect x="0" y="0" width="1" height="1"/></clipPath>' +
        '<pattern id="p1-dots" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="1.2" fill="#000000" fill-opacity="0.35"/></pattern>' +
        '<pattern id="p1-crossHatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 8L8 0M0 0L8 8" fill="none" stroke="#000000" stroke-opacity="0.35" stroke-width="1.5"/></pattern>' +
        '</defs>' +
        '<rect x="0" y="0" width="8" height="8" fill="url(#p1-dots)"/>' +
        '<g clip-path="url(#p1-c0)">' +
        '<rect x="0" y="0" width="8" height="8" fill="url(#p1-dots)"/>' +
        '<rect x="0" y="0" width="8" height="8" fill="url(#p1-crossHatch)"/>' +
        '</g>' +
        '<g clip-path="url(#p1-c1)"></g>' +
        '</svg>',
    );
  });

  it.each([
    [
      'portrait A3',
      'a3',
      'portrait',
      'width="841.89pt" height="1190.55pt" viewBox="0 0 841.89 1190.55"',
    ],
    [
      'landscape US Letter',
      'letter',
      'landscape',
      'width="792pt" height="612pt" viewBox="0 0 792 612"',
    ],
  ] as const)('sizes a %s page', (_name, paper, orientation, size) => {
    const svg = printPageSvg({ ...documentOf([]), paper, orientation }, 0);
    expect(svg.slice(0, 120)).toContain(size);
  });

  it('throws for a page the document does not have', () => {
    expect(() => printPageSvg(documentOf([]), 1)).toThrow('No page 1 to write.');
  });

  it('writes balanced markup for any valid document, every text decoding back to itself', () => {
    fc.assert(
      fc.property(printDocumentArbitrary, (document) => {
        document.pages.forEach((orders, index) => {
          const svg = printPageSvg(document, index);
          expect(isBalancedMarkup(svg)).toBe(true);
          const texts = orders.flatMap((order) => (order.kind === 'clip' ? order.orders : [order]));
          expect(textsOf(svg)).toEqual(
            texts.flatMap((order) => (order.kind === 'text' ? [order.text] : [])),
          );
        });
      }),
    );
  });

  it('catches unbalanced markup in its own check', () => {
    expect(isBalancedMarkup('<svg><g></svg>')).toBe(false);
    expect(isBalancedMarkup('<svg>a<b</svg>')).toBe(false);
    expect(isBalancedMarkup('<svg><g/></svg>')).toBe(true);
  });
});

describe('svgNumber', () => {
  it.each([
    [10, '10'],
    [20.004, '20'],
    [20.005, '20.01'],
    [0.1 + 0.2, '0.3'],
    [-0.001, '0'],
    [-0, '0'],
    [1e-7, '0'],
    [-32_768, '-32768'],
    [65_536, '65536'],
  ])('writes %d as %s', (value, written) => {
    expect(svgNumber(value)).toBe(written);
  });
});

describe('escapeMarkup', () => {
  it('escapes the five markup characters and leaves the rest', () => {
    expect(escapeMarkup(`a&b<c>d"e'f é 漢 😀`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f é 漢 😀');
  });
});
