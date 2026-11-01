import { describe, expect, it, vi } from 'vitest';
import { keepSpellCheckingLocal } from './spell-checking';

describe('keepSpellCheckingLocal', () => {
  it('turns spell checking off on Linux, where it would download dictionaries', () => {
    const pageSession = { setSpellCheckerEnabled: vi.fn() };
    keepSpellCheckingLocal('linux', pageSession);
    expect(pageSession.setSpellCheckerEnabled.mock.calls).toEqual([[false]]);
  });

  it('keeps the spell checker of the system on Windows and macOS', () => {
    const pageSession = { setSpellCheckerEnabled: vi.fn() };
    keepSpellCheckingLocal('win32', pageSession);
    keepSpellCheckingLocal('darwin', pageSession);
    expect(pageSession.setSpellCheckerEnabled.mock.calls).toEqual([]);
  });
});
