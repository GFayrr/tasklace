import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './content-security-policy';

describe('contentSecurityPolicy', () => {
  it('allows only the application itself in production, with no inline code, no eval and no framing', () => {
    const policy = contentSecurityPolicy(false);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('unsafe');
    expect(policy).not.toContain('ws:');
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
