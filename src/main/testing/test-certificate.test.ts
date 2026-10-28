import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeTestCertificate } from './test-certificate';

const CERTIFICATES = 1024;

describe('the certificate a test makes for its relay', () => {
  it('is always readable, whatever serial number it draws', () => {
    const subjects = Array.from({ length: CERTIFICATES }, () => {
      const certificate = new X509Certificate(makeTestCertificate().certificate);
      return [certificate.subject, certificate.subjectAltName];
    });
    expect(subjects).toEqual(
      Array.from({ length: CERTIFICATES }, () => [
        'CN=Tasklace test relay',
        'DNS:localhost, IP Address:127.0.0.1',
      ]),
    );
  });
});
