import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './content-security-policy';

describe('contentSecurityPolicy', () => {
  it('allows only the application itself in production, with no inline code, no eval and no framing', () => {
    expect(contentSecurityPolicy(false)).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  });

  it('adds only inline styles and the reload socket of the development server', () => {
    const production = contentSecurityPolicy(false).split('; ');
    const development = contentSecurityPolicy(true).split('; ');
    const changed = development.filter((directive) => !production.includes(directive));
    expect(changed).toEqual([
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws://localhost:*",
    ]);
    expect(development).toHaveLength(production.length);
  });
});
