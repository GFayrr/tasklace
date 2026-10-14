import { describe, expect, it } from 'vitest';
import { checkedOrThrow } from '../testing/print-arbitrary';
import { printHtml } from './print-html';
import { printPageSvg } from './print-svg';

const DOCUMENT = checkedOrThrow({
  paper: 'a4',
  orientation: 'landscape',
  title: 'R&D <plan>',
  pages: [
    [
      {
        kind: 'text',
        x: 28,
        y: 40,
        text: 'Thesis',
        size: 16,
        weight: 600,
        color: '#1c1b19',
        align: 'start',
      },
    ],
    [],
  ],
});

describe('printHtml', () => {
  it('writes the escaped title, the stylesheets of the application and every page in order, with no script or inline style', () => {
    expect(printHtml(DOCUMENT)).toBe(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<title>R&amp;D &lt;plan&gt;</title>' +
        '<link rel="stylesheet" href="/fonts/jost.css"><link rel="stylesheet" href="/print/print.css">' +
        `</head><body>${printPageSvg(DOCUMENT, 0)}${printPageSvg(DOCUMENT, 1)}</body></html>`,
    );
    expect(printHtml(DOCUMENT)).not.toMatch(/<script|style=/);
  });
});
