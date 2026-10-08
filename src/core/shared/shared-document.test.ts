import { describe, expect, it } from 'vitest';
import { project, TEST_DOCUMENT_ID } from '../testing/project-builder';
import { TASK_KEYS_BY_KIND } from '../validation/read-project';
import {
  createSharedDocument,
  isDocumentId,
  readDocumentId,
  viewTaskFields,
} from './shared-document';

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

  it('shows only the fields of the kind of a task, leaving an entry of no known kind as it is', () => {
    const entry = { kind: 'milestone', id: 'm', name: 'M', segments: [], hoursPerDay: 4 };
    expect(viewTaskFields(entry)).toEqual(
      Object.fromEntries(
        TASK_KEYS_BY_KIND.milestone.map((key) => [key, Reflect.get(entry, key) as unknown]),
      ),
    );
    expect(TASK_KEYS_BY_KIND.milestone).not.toContain('segments');
    const unknownKind = { kind: 'other', segments: [] };
    expect(viewTaskFields(unknownKind)).toBe(unknownKind);
    expect(viewTaskFields(42)).toBe(42);
    expect(viewTaskFields(null)).toBeNull();
  });
});
