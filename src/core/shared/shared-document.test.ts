import { describe, expect, it } from 'vitest';
import { project, TEST_DOCUMENT_ID } from '../testing/project-builder';
import { createSharedDocument, isDocumentId, readDocumentId } from './shared-document';

describe('document identifier', () => {
  it('is written once when the shared document is created', () => {
    expect(readDocumentId(createSharedDocument(project([]), TEST_DOCUMENT_ID))).toBe(
      TEST_DOCUMENT_ID,
    );
  });

  it.each(['00000000-0000-4000-8000-000000000001', 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'])(
    'accepts %s',
    (value) => {
      expect(isDocumentId(value)).toBe(true);
    },
  );

  it.each([
    'A0B1C2D3-E4F5-4A6B-8C7D-9E0F1A2B3C4D',
    '00000000000040008000000000000001',
    '../local-copies/escape',
    '',
    42,
    null,
  ])('refuses %j', (value) => {
    expect(isDocumentId(value)).toBe(false);
  });
});
