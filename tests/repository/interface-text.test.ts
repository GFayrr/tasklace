import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

const LETTER_PATTERN = /\p{L}/u;
const SHOWN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'aria-label',
  'title',
  'placeholder',
  'alt',
]);
const SKIPPED_ROOT_KEYS: ReadonlySet<string> = new Set(['instance', 'module', 'css', 'options']);

/** Lists the Svelte components of the interface. */
function components(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src/renderer'],
    { encoding: 'utf8' },
  );
  return output.split('\0').filter((path) => path.endsWith('.svelte'));
}

/** Collects the texts with letters written directly in the markup, outside scripts and styles. */
function writtenTexts(node: unknown, shown: boolean, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => {
      writtenTexts(child, shown, found);
    });
    return;
  }
  if (typeof node !== 'object' || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  const isText = record['type'] === 'Text' && typeof record['data'] === 'string';
  if (isText && LETTER_PATTERN.test(String(record['data'])) && shown) {
    found.push(String(record['data']).trim());
  }
  const isAttribute = record['type'] === 'Attribute' && typeof record['name'] === 'string';
  Object.entries(record).forEach(([key, value]) => {
    if (SKIPPED_ROOT_KEYS.has(key) || key === 'parent') {
      return;
    }
    const childShown = isAttribute ? SHOWN_ATTRIBUTES.has(String(record['name'])) : shown;
    writtenTexts(value, childShown, found);
  });
}

/** Lists the texts written directly in a component instead of coming from the translation files. */
function hardCodedTexts(path: string): string[] {
  const root = parse(readFileSync(path, 'utf8'), { modern: true });
  const found: string[] = [];
  writtenTexts(root.fragment, true, found);
  return found;
}

describe('interface texts', () => {
  it('finds the components to check', () => {
    expect(components().length).toBeGreaterThan(0);
  });

  it.each(components())('writes no visible text directly in %s', (path) => {
    expect(hardCodedTexts(path)).toEqual([]);
  });

  it('catches a text written directly, in the markup or in a shown attribute', () => {
    const root = parse('<p>Hello</p><button aria-label="Close" class="x">{label}</button>', {
      modern: true,
    });
    const found: string[] = [];
    writtenTexts(root.fragment, true, found);
    expect(found).toEqual(['Hello', 'Close']);
  });
});
