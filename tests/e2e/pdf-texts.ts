import { inflateSync } from 'node:zlib';

export interface PdfTexts {
  readonly title: string;
  readonly texts: readonly string[];
}

const OBJECT = /(\d+) 0 obj([\s\S]*?)endobj/g;
const STREAM = /stream\r?\n([\s\S]*?)\r?\nendstream/;
const FONT_RESOURCE = /\/(F\d+) (\d+) 0 R/g;
const TEXT_BLOCK = /BT\n([\s\S]*?)\nET/g;
const GLYPHS = /<([0-9A-Fa-f]+)> Tj/g;
const CHARACTER = /<([0-9A-Fa-f]{4})> <([0-9A-Fa-f]+)>/g;
const CHARACTER_RANGE = /<([0-9A-Fa-f]{4})> <([0-9A-Fa-f]{4})> <([0-9A-Fa-f]+)>/g;
const HEX_TITLE = /\/Title <FEFF([0-9A-Fa-f]*)>/;
const LITERAL_TITLE = /\/Title \(((?:\\.|[^\\)])*)\)/;
const UNIT_DIGITS = 4;
const HEX_RADIX = 16;

/** Reads back the title of a PDF printed by Chromium and every text its pages show, one per text block, in drawing order. */
export function readPdfTexts(pdf: Buffer): PdfTexts {
  const objects = objectsOf(pdf.toString('latin1'));
  const fonts = new Map<string, ReadonlyMap<number, string>>();
  for (const [, resource = '', object = ''] of pdf.toString('latin1').matchAll(FONT_RESOURCE)) {
    fonts.set(resource, unicodeOf(objects, object));
  }
  const texts = [...objects.values()]
    .map((body) => contentOf(body))
    .flatMap((content) => [...content.matchAll(TEXT_BLOCK)].map(([, block = '']) => block))
    .map((block) => textOf(block, fonts));
  return { title: titleOf(pdf.toString('latin1')), texts };
}

/** Returns the bodies of the objects of a PDF by number. */
function objectsOf(pdf: string): Map<string, string> {
  return new Map([...pdf.matchAll(OBJECT)].map(([, number = '', body = '']) => [number, body]));
}

/** Returns the content of the stream of an object, inflated when compressed, or nothing when it holds no stream. */
function contentOf(body: string): string {
  const data = STREAM.exec(body)?.[1];
  if (data === undefined) {
    return '';
  }
  const bytes = Buffer.from(data, 'latin1');
  return body.includes('/FlateDecode') ? inflateSync(bytes).toString('latin1') : data;
}

/** Reads the map from glyph codes to characters of a font, from the ToUnicode stream it names. */
function unicodeOf(objects: Map<string, string>, fontObject: string): Map<number, string> {
  const unicode = /\/ToUnicode (\d+) 0 R/.exec(objects.get(fontObject) ?? '')?.[1] ?? '';
  const cmap = contentOf(objects.get(unicode) ?? '');
  const map = new Map<number, string>();
  for (const [, code = '', character = ''] of cmap.matchAll(CHARACTER)) {
    map.set(Number.parseInt(code, HEX_RADIX), charactersOf(character));
  }
  for (const [, first = '', last = '', character = ''] of cmap.matchAll(CHARACTER_RANGE)) {
    addRange(map, Number.parseInt(first, HEX_RADIX), Number.parseInt(last, HEX_RADIX), character);
  }
  return map;
}

/** Maps each code of a range to the characters that follow its first one in order. */
function addRange(map: Map<number, string>, first: number, last: number, start: string): void {
  const firstCharacter = Number.parseInt(start, HEX_RADIX);
  for (let code = first; code <= last; code += 1) {
    map.set(code, String.fromCharCode(firstCharacter + code - first));
  }
}

/** Reads the text a block shows, from the font it sets and the glyph codes it writes. */
function textOf(block: string, fonts: ReadonlyMap<string, ReadonlyMap<number, string>>): string {
  const unicode =
    fonts.get(/\/(F\d+) [\d.]+ Tf/.exec(block)?.[1] ?? '') ?? new Map<number, string>();
  return [...block.matchAll(GLYPHS)]
    .flatMap(([, codes = '']) => unitsOf(codes))
    .map((code) => unicode.get(Number.parseInt(code, HEX_RADIX)) ?? '?')
    .join('');
}

/** Reads the title of a PDF, written either as text in parentheses or as UTF-16 in hexadecimal. */
function titleOf(pdf: string): string {
  const hex = HEX_TITLE.exec(pdf)?.[1];
  if (hex !== undefined) {
    return charactersOf(hex);
  }
  return (LITERAL_TITLE.exec(pdf)?.[1] ?? '').replace(/\\([()\\])/g, '$1');
}

/** Turns UTF-16 code units written in hexadecimal into characters. */
function charactersOf(hex: string): string {
  return String.fromCharCode(...unitsOf(hex).map((unit) => Number.parseInt(unit, HEX_RADIX)));
}

/** Splits hexadecimal digits into groups of four, one per code. */
function unitsOf(hex: string): string[] {
  return hex.match(new RegExp(`.{${String(UNIT_DIGITS)}}`, 'g')) ?? [];
}
