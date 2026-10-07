import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { createSharedDocument, readSharedData } from './shared-document';
import { mergeSharedUpdate } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

const repairing = vi.hoisted(() => ({ broken: false, skipped: false, fittingBroken: false }));

vi.mock('./repair-project', async (importOriginal) => {
  const original = await importOriginal<typeof import('./repair-project')>();
  return {
    ...original,
    fitDailyPattern: (...values: Parameters<typeof original.fitDailyPattern>) => {
      if (repairing.fittingBroken) {
        throw new Error('fitting broken');
      }
      return original.fitDailyPattern(...values);
    },
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
  repairing.fittingBroken = false;
});

/** Checks that the indexed state of a session matches its document: the project read from scratch, and a link to a task the document lacks refused. */
function expectConsistent(session: SharedSession): void {
  const reopened = openSharedSession(session.document);
  expect(reopened.ok && reopened.value.project()).toEqual(session.project());
  expect(session.apply({ type: 'putDependency', dependency: link('a', 'zzz') }).ok).toBe(false);
}

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
    expectConsistent(session);
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
    for (const merged of [session.merge(garbage), mergeSharedUpdate(session.document, garbage)]) {
      expect(merged.ok || merged.error.kind).toBe('malformedUpdate');
      expect(
        !merged.ok && merged.error.kind === 'malformedUpdate' && merged.error.error,
      ).toBeInstanceOf(Error);
    }
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

  it('fails as a failed repair when the repair of only what changed raises, keeping the session consistent, then merges again', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const session = sessionOn(origin);
    const peer = sessionOn(origin);
    const before = Y.encodeStateVector(peer.document);
    expect(peer.apply({ type: 'putTask', task: workTask('a', { name: 'Renamed' }) }).ok).toBe(true);
    const update = Y.encodeStateAsUpdate(peer.document, before);
    const data = readSharedData(session.document);
    repairing.fittingBroken = true;
    expect(session.merge(update)).toEqual({
      ok: false,
      error: { kind: 'repairFailed', error: new Error('fitting broken') },
    });
    expect(readSharedData(session.document)).toEqual(data);
    expectConsistent(session);
    repairing.fittingBroken = false;
    expect(session.merge(update).ok).toBe(true);
    expect(session.project().tasks.find((task) => task.id === 'a')?.name).toBe('Renamed');
  });
});

describe('an undo or redo whose repair raises an exception', () => {
  it('fails as a failed repair, leaving the step undone or redone as it was, then works again', () => {
    const session = sessionOn(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID));
    const calendar = { ...SAMPLE.calendar, workingTimeRanges: MORNING_ONLY };
    expect(session.apply({ type: 'updateProject', fields: { calendar } }).ok).toBe(true);
    const changed = readSharedData(session.document);
    repairing.broken = true;
    const failed = {
      ok: false,
      error: { kind: 'repairFailed', error: new Error('repair broken') },
    };
    expect(session.history.undo()).toEqual(failed);
    expect(readSharedData(session.document)).toEqual(changed);
    expect(session.project().calendar.workingTimeRanges).toEqual(MORNING_ONLY);
    expect(session.history.canUndo()).toBe(true);
    expectConsistent(session);
    repairing.broken = false;
    expect(session.history.undo().ok).toBe(true);
    expect(session.project().calendar).toEqual(SAMPLE.calendar);
    const undone = readSharedData(session.document);
    repairing.broken = true;
    expect(session.history.redo()).toEqual(failed);
    expect(readSharedData(session.document)).toEqual(undone);
    expect(session.history.canRedo()).toBe(true);
    expectConsistent(session);
    repairing.broken = false;
    expect(session.history.redo().ok).toBe(true);
    expect(session.project().calendar.workingTimeRanges).toEqual(MORNING_ONLY);
  });
});
