import { describe, expect, it } from 'vitest';
import { MAX_EXTERNAL_URL_LENGTH } from '../core/limits';
import { isAllowedExternalUrl } from './external-links';

describe('isAllowedExternalUrl', () => {
  it.each([
    'https://github.com/GFayrr/tasklace',
    'https://github.com/GFayrr/tasklace/',
    'https://github.com/GFayrr/tasklace/releases/latest',
    'https://github.com/GFayrr/tasklace/blob/main/docs/roadmap.md#step-5',
  ])('allows %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    'http://github.com/GFayrr/tasklace',
    'https://github.com/GFayrr/tasklace-evil',
    'https://github.com/GFayrr',
    'https://github.com.evil.example/GFayrr/tasklace',
    'https://user:secret@github.com/GFayrr/tasklace',
    'https://github.com/GFayrr/tasklace/../other',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    '',
    42,
    null,
    { toString: () => 'https://github.com/GFayrr/tasklace' },
  ])('refuses %j', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });

  it('refuses an address longer than the limit, and accepts one of the limit', () => {
    const base = 'https://github.com/GFayrr/tasklace/';
    expect(isAllowedExternalUrl(base + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH - base.length))).toBe(
      true,
    );
    expect(isAllowedExternalUrl(base + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH - base.length + 1))).toBe(
      false,
    );
  });
});
