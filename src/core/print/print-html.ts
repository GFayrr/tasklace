import { escapeMarkup, printPageSvg } from './print-svg';
import type { CheckedPrintDocument } from './read-print-document';

export const PRINT_STYLESHEETS: readonly string[] = ['/fonts/jost.css', '/print/print.css'];

/** Writes the page that the PDF is printed from: the title of the document and one SVG image per sheet, styled only by the stylesheets of the application, in time linear in the orders. */
export function printHtml(document: CheckedPrintDocument): string {
  const links = PRINT_STYLESHEETS.map((href) => `<link rel="stylesheet" href="${href}">`).join('');
  const pages = document.pages.map((_orders, index) => printPageSvg(document, index)).join('');
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${escapeMarkup(document.title)}</title>${links}</head><body>${pages}</body></html>`
  );
}
