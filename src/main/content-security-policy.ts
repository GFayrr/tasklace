const PRODUCTION_DIRECTIVES: readonly string[] = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
];

const DEVELOPMENT_OVERRIDES: Readonly<Record<string, string>> = {
  'style-src': "style-src 'self' 'unsafe-inline'",
  'connect-src': "connect-src 'self' ws://localhost:*",
};

/** Returns the content security policy of the application, the development server alone being allowed inline styles and its reload socket. */
export function contentSecurityPolicy(isDevelopment: boolean): string {
  return PRODUCTION_DIRECTIVES.map((directive) => {
    const name = directive.split(' ', 1).join('');
    return isDevelopment ? (DEVELOPMENT_OVERRIDES[name] ?? directive) : directive;
  }).join('; ');
}
