import { MAX_EXTERNAL_URL_LENGTH } from '../core/limits';
import { formatVersion, type Version } from '../core/version';

export const REPOSITORY_URL = 'https://github.com/GFayrr/tasklace';
const ALLOWED_PREFIXES: readonly string[] = [REPOSITORY_URL];

export const WORKING_REMOTELY_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/working-remotely.md`;
export const PRIVACY_POLICY_URL = `${REPOSITORY_URL}/blob/main/PRIVACY.md`;

/** Builds the address of the page of a release of Tasklace from its version, never from an address another system gave. */
export function releasePageUrl(version: Version): string {
  return `${REPOSITORY_URL}/releases/tag/v${formatVersion(version)}`;
}

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
