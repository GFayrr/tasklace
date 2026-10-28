import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { getCACertificates } from 'node:tls';

interface TestCertificate {
  readonly certificate: string;
  readonly key: string;
}

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OBJECT_IDENTIFIER = 0x06;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;
const EXPLICIT_VERSION = 0xa0;
const EXPLICIT_EXTENSIONS = 0xa3;
const DNS_NAME = 0x82;
const IP_ADDRESS = 0x87;
const VERSION_3 = 2;
const SHORT_LENGTH_LIMIT = 0x80;
const LONG_LENGTH_MARK = 0x80;
const BYTE_MASK = 0xff;
const OBJECT_IDENTIFIER_BASE = 128;
const FIRST_ARCS_FACTOR = 40;
const SERIAL_BYTES = 16;
const POSITIVE_MASK = 0x7f;
const ECDSA_WITH_SHA256 = [1, 2, 840, 10045, 4, 3, 2];
const COMMON_NAME = [2, 5, 4, 3];
const SUBJECT_ALTERNATIVE_NAME = [2, 5, 29, 17];
const NAME = 'Tasklace test relay';
const HOST_NAME = 'localhost';
const LOOPBACK_ADDRESS = [127, 0, 0, 1];
const VALID_BEFORE_MILLISECONDS = 3_600_000;
const VALID_FOR_MILLISECONDS = 86_400_000;
const PEM_LINE_LENGTH = 64;

/** Writes a value of a type in DER, its length in the short form below 128 bytes and in the long form above. */
function der(type: number, ...parts: readonly Uint8Array[]): Uint8Array {
  const content = Buffer.concat(parts);
  return Buffer.concat([Uint8Array.of(type), derLength(content.length), content]);
}

/** Writes the length of a DER value. */
function derLength(length: number): Uint8Array {
  if (length < SHORT_LENGTH_LIMIT) {
    return Uint8Array.of(length);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / (BYTE_MASK + 1))) {
    bytes.unshift(rest & BYTE_MASK);
  }
  return Uint8Array.of(LONG_LENGTH_MARK | bytes.length, ...bytes);
}

/** Writes an object identifier, its first two arcs in one byte and each other arc in base 128. */
function objectIdentifier(arcs: readonly number[]): Uint8Array {
  const [first = 0, second = 0, ...rest] = arcs;
  const bytes = [first * FIRST_ARCS_FACTOR + second];
  for (const arc of rest) {
    const digits = [arc % OBJECT_IDENTIFIER_BASE];
    for (let left = Math.floor(arc / OBJECT_IDENTIFIER_BASE); left > 0;) {
      digits.unshift((left % OBJECT_IDENTIFIER_BASE) | LONG_LENGTH_MARK);
      left = Math.floor(left / OBJECT_IDENTIFIER_BASE);
    }
    bytes.push(...digits);
  }
  return der(OBJECT_IDENTIFIER, Uint8Array.from(bytes));
}

/** Writes an instant as a UTC time of X.509, to the second. */
function utcTime(instant: Date): Uint8Array {
  const text = instant.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return der(UTC_TIME, Buffer.from(text, 'ascii'));
}

/** Writes the name of the test relay, used as both issuer and subject. */
function relayName(): Uint8Array {
  return der(
    SEQUENCE,
    der(SET, der(SEQUENCE, objectIdentifier(COMMON_NAME), der(UTF8_STRING, Buffer.from(NAME)))),
  );
}

/** Writes the extension that names localhost and 127.0.0.1, the names a test reaches the relay by. */
function alternativeNames(): Uint8Array {
  const names = der(
    SEQUENCE,
    der(DNS_NAME, Buffer.from(HOST_NAME, 'ascii')),
    der(IP_ADDRESS, Uint8Array.from(LOOPBACK_ADDRESS)),
  );
  return der(
    EXPLICIT_EXTENSIONS,
    der(
      SEQUENCE,
      der(SEQUENCE, objectIdentifier(SUBJECT_ALTERNATIVE_NAME), der(OCTET_STRING, names)),
    ),
  );
}

/** Writes the part of the certificate its key signs. */
function certificateBody(publicKey: KeyObject, now: number): Uint8Array {
  const serial = randomBytes(SERIAL_BYTES);
  serial[0] = (serial[0] ?? 0) & POSITIVE_MASK;
  return der(
    SEQUENCE,
    der(EXPLICIT_VERSION, der(INTEGER, Uint8Array.of(VERSION_3))),
    der(INTEGER, serial),
    der(SEQUENCE, objectIdentifier(ECDSA_WITH_SHA256)),
    relayName(),
    der(
      SEQUENCE,
      utcTime(new Date(now - VALID_BEFORE_MILLISECONDS)),
      utcTime(new Date(now + VALID_FOR_MILLISECONDS)),
    ),
    relayName(),
    publicKey.export({ type: 'spki', format: 'der' }),
    alternativeNames(),
  );
}

/** Wraps DER bytes as PEM text under a label. */
function pem(label: string, bytes: Uint8Array): string {
  const lines = Buffer.from(bytes)
    .toString('base64')
    .match(new RegExp(`.{1,${String(PEM_LINE_LENGTH)}}`, 'g'));
  return `-----BEGIN ${label}-----\n${(lines ?? []).join('\n')}\n-----END ${label}-----\n`;
}

/** Makes a new self-signed certificate for localhost and 127.0.0.1, valid for a day, so that a test reaches a relay over TLS with no file kept in the repository. */
export function makeTestCertificate(): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const body = certificateBody(publicKey, Date.now());
  const signature = sign('sha256', body, privateKey);
  const certificate = der(
    SEQUENCE,
    body,
    der(SEQUENCE, objectIdentifier(ECDSA_WITH_SHA256)),
    der(BIT_STRING, Uint8Array.of(0), signature),
  );
  return {
    certificate: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export const TEST_CERTIFICATE = makeTestCertificate();

/** Writes the test certificate and its key in a folder, giving the settings that make a relay serve them over TLS. */
export async function writeRelayCertificate(
  folder: string,
): Promise<{ readonly RELAY_TLS_CERT: string; readonly RELAY_TLS_KEY: string }> {
  const certificateFile = join(folder, 'relay-certificate.pem');
  const keyFile = join(folder, 'relay-key.pem');
  await writeFile(certificateFile, TEST_CERTIFICATE.certificate);
  await writeFile(keyFile, TEST_CERTIFICATE.key);
  return { RELAY_TLS_CERT: certificateFile, RELAY_TLS_KEY: keyFile };
}

/** Wraps the certificates Node trusts so that the default ones include the test certificate, as a computer told to trust it would. */
export function trustingTestCertificate(
  certificates: typeof getCACertificates,
): typeof getCACertificates {
  return (kind) =>
    kind === 'default'
      ? [...certificates('default'), TEST_CERTIFICATE.certificate]
      : certificates(kind);
}
