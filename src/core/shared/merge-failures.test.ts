import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { createSharedDocument, readSharedData } from './shared-document';
import { mergeSharedUpdate } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

const repairing = vi.hoisted(() => ({ broken: false, skipped: false }));

vi.mock('./repair-project', async (importOriginal) => {
  const original = await importOriginal<typeof import('./repair-project')>();
  return {
    ...original,
    repairProject: (...values: Parameters<typeof original.repairProject>) => {
      if (repairing.broken) {
        throw new Error('repair broken');
      }
      if (repairing.skipped) {
        return { ok: true, value: { project: values[0], repairs: [] } };
      }
      return original.repairProject(...values);
    },
  };
});

const SAMPLE = project([workTask('a'), workTask('b')]);
const MORNING_ONLY = [{ startHour: 9, endHour: 12 }];

afterEach(() => {
  repairing.broken = false;
  repairing.skipped = false;
});

/** Opens a session on a copy of a document, failing the test when it is refused. */
function sessionOn(document: Y.Doc): SharedSession {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  const session = openSharedSession(copy);
  if (!session.ok) {
    throw new Error(JSON.stringify(session.error));
  }
  return session.value;
}

/** Returns the update a peer sends after changing the calendar, a change that repairs the whole project. */
function calendarUpdate(origin: Y.Doc): Uint8Array {
  const peer = sessionOn(origin);
  const before = Y.encodeStateVector(peer.document);
  const applied = peer.apply({
    type: 'updateProject',
    fields: { calendar: { ...SAMPLE.calendar, workingTimeRanges: MORNING_ONLY } },
  });
  if (!applied.ok) {
    throw new Error(JSON.stringify(applied.error));
  }
  return Y.encodeStateAsUpdate(peer.document, before);
}

describe('a merge whose repair raises an exception', () => {
  it('fails as a failed repair in a session, keeping the document and project, then merges again', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const session = sessionOn(origin);
    const update = calendarUpdate(origin);
    const data = readSharedData(session.document);
    const before = session.project();
    repairing.broken = true;
    expect(session.merge(update)).toEqual({
      ok: false,
      error: { kind: 'repairFailed', error: new Error('repair broken') },
    });
    expect(readSharedData(session.document)).toEqual(data);
    expect(session.project()).toEqual(before);
    repairing.broken = false;
    expect(session.merge(update).ok).toBe(true);
    expect(session.project().calendar.workingTimeRanges).toEqual(MORNING_ONLY);
  });

  it('fails as a failed repair in a full merge, leaving the document as it was', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const document = sessionOn(origin).document;
    const data = readSharedData(document);
    repairing.broken = true;
    expect(mergeSharedUpdate(document, calendarUpdate(origin))).toEqual({
      ok: false,
      error: { kind: 'repairFailed', error: new Error('repair broken') },
    });
    expect(readSharedData(document)).toEqual(data);
  });

  it('still calls unreadable bytes a malformed update', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const session = sessionOn(origin);
    const garbage = Uint8Array.from([255, 255, 255, 255, 1]);
    expect(session.merge(garbage)).toMatchObject({ ok: false, error: { kind: 'malformedUpdate' } });
    expect(mergeSharedUpdate(session.document, garbage)).toMatchObject({
      ok: false,
      error: { kind: 'malformedUpdate' },
    });
  });

  it('refuses a full merge that the repair leaves invalid, leaving the document as it was', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const alice = sessionOn(origin);
    const bob = sessionOn(origin);
    expect(alice.apply({ type: 'putDependency', dependency: link('a', 'b') }).ok).toBe(true);
    const before = Y.encodeStateVector(bob.document);
    expect(bob.apply({ type: 'putDependency', dependency: link('b', 'a') }).ok).toBe(true);
    const update = Y.encodeStateAsUpdate(bob.document, before);
    const data = readSharedData(alice.document);
    repairing.skipped = true;
    const merged = mergeSharedUpdate(alice.document, update);
    expect(merged.ok || merged.error.kind).toBe('invalidProject');
    expect(
      merged.ok || ('issues' in merged.error && merged.error.issues.map((issue) => issue.code)),
    ).toEqual(['DEPENDENCY_CYCLE', 'DEPENDENCY_CYCLE']);
    expect(readSharedData(alice.document)).toEqual(data);
  });
});
