import { MAX_EXTERNAL_URL_LENGTH } from '../core/limits';

const ALLOWED_PREFIXES: readonly string[] = ['https://github.com/GFayrr/tasklace'];

/** Tells whether an untrusted value is an https address the application may open in the browser, from an explicit list of allowed places. */
export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH || !URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  const normalized = `${url.origin}${url.pathname}`;
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
  );
}
