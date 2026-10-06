import fc from 'fast-check';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/arbitraries';
import { hideListContent } from '../testing/hidden-list-content';
import type { Project, Tag } from '../model/project';
import {
  link,
  milestone,
  project,
  splitTask,
  summary,
  TEST_DOCUMENT_ID,
  workTask,
} from '../testing/project-builder';
import type { SharedOperation } from './shared-operations';
import { createSharedDocument, PROJECT_ROOT, readSharedData, TASKS_ROOT } from './shared-document';
import { mergeSharedUpdate, readSharedProject } from './shared-project';
import { openSharedSession, type SharedSession } from './shared-session';

const repairing = vi.hoisted(() => ({ refused: false }));

vi.mock('./shared-project', async (importOriginal) => {
  const original = await importOriginal<typeof import('./shared-project')>();
  return {
    ...original,
    repairDocumentProject: (...values: Parameters<typeof original.repairDocumentProject>) =>
      repairing.refused
        ? { ok: false, error: [{ path: 'calendar', code: 'NO_WORKING_WEEKDAY' }] }
        : original.repairDocumentProject(...values),
  };
});

const SAMPLE = project([workTask('a'), workTask('b')]);
const MORNING_ONLY = [{ startHour: 9, endHour: 12 }];
const OTHER_DOCUMENT_ID = '00000000-0000-4000-8000-000000000002';
const DESIGN: Tag = {
  id: 'design',
  name: 'Design',
  color: '#336699',
  representsPersonOrTeam: false,
};

afterEach(() => {
  repairing.refused = false;
});

/** Opens a session on a copy of a document, failing the test when it is refused. */
function sessionOn(document: Y.Doc, clientId: number): SharedSession {
  const copy = new Y.Doc();
  copy.clientID = clientId;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  const session = openSharedSession(copy);
  if (!session.ok) {
    throw new Error(JSON.stringify(session.error));
  }
  return session.value;
}

/** Returns the shared entry of a task, failing the test when it is missing. */
function taskEntry(document: Y.Doc, id: string): Y.Map<unknown> {
  const entry = document.getMap(TASKS_ROOT).get(id);
  if (!(entry instanceof Y.Map)) {
    throw new Error(`Missing task ${id}`);
  }
  return entry;
}

/** Returns what a peer sends after tampering with its copy of a document. */
function tamperedUpdate(origin: Y.Doc, tamper: (malicious: Y.Doc) => void): Uint8Array {
  const malicious = new Y.Doc();
  malicious.clientID = 99;
  Y.applyUpdate(malicious, Y.encodeStateAsUpdate(origin));
  const before = Y.encodeStateVector(malicious);
  tamper(malicious);
  return Y.encodeStateAsUpdate(malicious, before);
}

/** Returns the update a peer sends after renaming a task. */
function renameUpdate(peer: SharedSession, id: string, name: string): Uint8Array {
  const before = Y.encodeStateVector(peer.document);
  const applied = peer.apply({ type: 'putTask', task: workTask(id, { name }) });
  if (!applied.ok) {
    throw new Error(JSON.stringify(applied.error));
  }
  return Y.encodeStateAsUpdate(peer.document, before);
}

describe('a session receiving updates from the network', () => {
  it.each<[string, (malicious: Y.Doc) => void]>([
    ['an unknown root', (malicious) => malicious.getMap('other').set('x', 1)],
    ['an entry that is not a map', (malicious) => malicious.getMap(TASKS_ROOT).set('z', 1)],
    ['an unknown field on a task', (malicious) => taskEntry(malicious, 'a').set('junk', 'x')],
    ['a nested shared type', (malicious) => taskEntry(malicious, 'a').set('name', new Y.Text('a'))],
    ['an invalid hidden field', (malicious) => taskEntry(malicious, 'a').set('segments', 'x')],
    ['an unknown project field', (malicious) => malicious.getMap('project').set('extra', 1)],
    ['an invalid project name', (malicious) => malicious.getMap('project').set('name', '')],
    [
      'a project name of the wrong type',
      (malicious) => malicious.getMap('project').set('name', 42),
    ],
    ['an empty task name', (malicious) => taskEntry(malicious, 'a').set('name', '')],
    ['a task name of the wrong type', (malicious) => taskEntry(malicious, 'a').set('name', 42)],
    [
      'another document identifier',
      (malicious) => malicious.getMap('project').set('documentId', OTHER_DOCUMENT_ID),
    ],
    [
      'list content in a root',
      (malicious) => {
        hideListContent(malicious.getMap(TASKS_ROOT));
      },
    ],
  ])(
    'refuses %s as the full merge does, leaving its document and project, then accepts an honest update',
    (_label, tamper) => {
      const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
      const victim = sessionOn(origin, 1);
      const reference = sessionOn(origin, 2).document;
      const data = readSharedData(victim.document);
      const before = victim.project();
      const update = tamperedUpdate(origin, tamper);
      const merged = victim.merge(update);
      const full = mergeSharedUpdate(reference, update);
      expect(merged.ok).toBe(false);
      expect(merged).toEqual(full);
      expect(readSharedData(victim.document)).toEqual(data);
      expect(victim.project()).toEqual(before);
      const honest = sessionOn(origin, 3);
      expect(victim.merge(renameUpdate(honest, 'a', 'Honest')).ok).toBe(true);
      expect(victim.project().tasks.find((task) => task.id === 'a')?.name).toBe('Honest');
    },
  );

  it('names the place of a broken schema exactly', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const victim = sessionOn(origin, 1);
    const unknownRoot = tamperedUpdate(origin, (malicious) =>
      malicious.getMap('other').set('x', 1),
    );
    expect(victim.merge(unknownRoot)).toEqual({
      ok: false,
      error: { kind: 'invalidProject', issues: [{ path: 'other', code: 'UNKNOWN_FIELD' }] },
    });
    const notAMap = tamperedUpdate(origin, (malicious) => malicious.getMap(TASKS_ROOT).set('z', 1));
    expect(victim.merge(notAMap)).toEqual({
      ok: false,
      error: { kind: 'invalidProject', issues: [{ path: 'tasks.z', code: 'WRONG_TYPE' }] },
    });
  });

  it('holds back an update that arrives before the one it depends on, then joins once both are merged together', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const sender = sessionOn(origin, 1);
    const receiver = sessionOn(origin, 2);
    const first = renameUpdate(sender, 'a', 'First');
    const second = renameUpdate(sender, 'a', 'Second');
    const data = readSharedData(receiver.document);
    const before = receiver.project();
    expect(receiver.merge(second)).toEqual({ ok: false, error: { kind: 'incompleteUpdate' } });
    expect(readSharedData(receiver.document)).toEqual(data);
    expect(receiver.project()).toEqual(before);
    expect(receiver.merge(Y.mergeUpdates([second, first]))).toEqual({ ok: true, value: [] });
    expect(receiver.project()).toEqual(sender.project());
  });

  it('puts an undone step back when the project cannot be repaired, keeping it to undo later', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const session = sessionOn(origin, 1);
    const changed = session.apply({
      type: 'updateProject',
      fields: { calendar: { ...SAMPLE.calendar, workingTimeRanges: MORNING_ONLY } },
    });
    expect(changed.ok).toBe(true);
    const data = readSharedData(session.document);
    const before = session.project();
    repairing.refused = true;
    expect(session.history.undo()).toEqual({
      ok: false,
      error: {
        kind: 'invalidProject',
        issues: [{ path: 'calendar', code: 'NO_WORKING_WEEKDAY' }],
      },
    });
    expect(readSharedData(session.document)).toEqual(data);
    expect(session.project()).toEqual(before);
    expect(session.history.canUndo()).toBe(true);
    repairing.refused = false;
    expect(session.history.undo().ok).toBe(true);
    expect(session.project().calendar.workingTimeRanges).toEqual(SAMPLE.calendar.workingTimeRanges);
    const peer = sessionOn(origin, 2);
    expect(session.merge(renameUpdate(peer, 'b', 'After')).ok).toBe(true);
    const read = readSharedProject(session.document);
    expect(read.ok && read.value.tasks.find((task) => task.id === 'b')?.name).toBe('After');
  });

  it('shares the baseline switch between participants, refusing a value that is not a switch', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const alice = sessionOn(origin, 1);
    const bob = sessionOn(origin, 2);
    const before = Y.encodeStateVector(alice.document);
    const options = { ...SAMPLE.options, baselineEnabled: true };
    expect(alice.apply({ type: 'updateProject', fields: { options } }).ok).toBe(true);
    expect(bob.merge(Y.encodeStateAsUpdate(alice.document, before))).toEqual({
      ok: true,
      value: [],
    });
    expect(bob.project().options).toEqual(options);
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(alice.document));
    const forged = Y.encodeStateVector(forger);
    forger.getMap(PROJECT_ROOT).set('baselineEnabled', 'yes');
    const data = readSharedData(bob.document);
    expect(bob.merge(Y.encodeStateAsUpdate(forger, forged))).toEqual({
      ok: false,
      error: {
        kind: 'invalidProject',
        issues: [{ path: 'options.baselineEnabled', code: 'WRONG_TYPE' }],
      },
    });
    expect(readSharedData(bob.document)).toEqual(data);
  });

  it('keeps one whole baseline when two participants take one at the same time, the same for both', () => {
    const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const alice = sessionOn(origin, 1);
    const bob = sessionOn(origin, 2);
    const baselineOf = (hours: number) => ({
      takenAt: SAMPLE.startDate + hours,
      entries: ['a', 'b'].map((taskId) => ({
        taskId,
        start: SAMPLE.startDate + hours,
        end: SAMPLE.startDate + hours + 1,
        durationHours: 1,
      })),
    });
    const fromAlice = baselineOf(1);
    const fromBob = baselineOf(2);
    const aliceBefore = Y.encodeStateVector(alice.document);
    const bobBefore = Y.encodeStateVector(bob.document);
    expect(alice.apply({ type: 'updateProject', fields: { baseline: fromAlice } }).ok).toBe(true);
    expect(bob.apply({ type: 'updateProject', fields: { baseline: fromBob } }).ok).toBe(true);
    const aliceUpdate = Y.encodeStateAsUpdate(alice.document, aliceBefore);
    const bobUpdate = Y.encodeStateAsUpdate(bob.document, bobBefore);
    expect(alice.merge(bobUpdate).ok).toBe(true);
    expect(bob.merge(aliceUpdate).ok).toBe(true);
    const kept = alice.project().baseline;
    expect(bob.project().baseline).toEqual(kept);
    expect([fromAlice, fromBob]).toContainEqual(kept);
  });

  it('removes at once a tag and a task it marked, as the full merge does, without adjusting the removed task', () => {
    const design = {
      id: 'design',
      name: 'Design',
      color: '#336699',
      representsPersonOrTeam: false,
    };
    const origin = createSharedDocument(
      project([workTask('a', { tagId: 'design' }), workTask('b', { tagId: 'design' })], [], {
        tags: [design],
      }),
      TEST_DOCUMENT_ID,
    );
    const sender = sessionOn(origin, 1);
    const receiver = sessionOn(origin, 2);
    const reference = sessionOn(origin, 3).document;
    const before = Y.encodeStateVector(sender.document);
    expect(
      sender.applyAll([
        { type: 'removeTasks', ids: ['a'] },
        { type: 'removeTag', id: 'design' },
      ]).ok,
    ).toBe(true);
    const update = Y.encodeStateAsUpdate(sender.document, before);
    const merged = receiver.merge(update);
    expect(merged).toEqual(mergeSharedUpdate(reference, update));
    expect(merged.ok).toBe(true);
    expect(
      receiver.project().tasks.map((task) => [task.id, 'tagId' in task ? task.tagId : null]),
    ).toEqual([['b', null]]);
  });

  it.each<[string, Project, readonly SharedOperation[], readonly SharedOperation[], string[]]>([
    [
      'a tag deleted while a task takes it',
      project([workTask('a')], [], { tags: [DESIGN] }),
      [{ type: 'removeTag', id: 'design' }],
      [{ type: 'putTask', task: workTask('a', { tagId: 'design' }) }],
      ['TAG_CLEARED'],
    ],
    [
      'two links that close a cycle',
      project([workTask('a'), workTask('b')]),
      [{ type: 'putDependency', dependency: link('a', 'b') }],
      [{ type: 'putDependency', dependency: link('b', 'a') }],
      ['DEPENDENCY_REMOVED'],
    ],
    [
      'a summary deleted while a task moves under it',
      project([summary('s'), workTask('a')]),
      [{ type: 'removeTasks', ids: ['s'] }],
      [{ type: 'putTask', task: workTask('a', { parentId: 's' }) }],
      ['MOVED_TO_ROOT'],
    ],
    [
      'a shorter day while a task asks for more hours',
      project([workTask('a')]),
      [
        {
          type: 'updateProject',
          fields: { calendar: { ...SAMPLE.calendar, workingTimeRanges: MORNING_ONLY } },
        },
      ],
      [{ type: 'putTask', task: workTask('a', { hoursPerDay: 6 }) }],
      ['HOURS_PER_DAY_REDUCED'],
    ],
    [
      'a shorter day while a task starts late each day',
      project([workTask('a')]),
      [
        {
          type: 'updateProject',
          fields: { calendar: { ...SAMPLE.calendar, workingTimeRanges: MORNING_ONLY } },
        },
      ],
      [{ type: 'putTask', task: workTask('a', { hoursPerDay: 2, dailyStartHour: 14 }) }],
      ['DAILY_START_HOUR_CLEARED'],
    ],
    [
      'a task turned into a milestone while its progress is set halfway',
      project([workTask('a')]),
      [{ type: 'putTask', task: milestone('a') }],
      [{ type: 'putTask', task: workTask('a', { progressPercent: 50 }) }],
      ['MILESTONE_PROGRESS_ROUNDED'],
    ],
    [
      'blocks removed while a link points at one of them',
      project([
        workTask('a'),
        splitTask('x', [
          [3, 0],
          [3, 1],
        ]),
      ]),
      [{ type: 'putTask', task: workTask('x') }],
      [{ type: 'putDependency', dependency: { ...link('a', 'x'), successorBlock: 1 } }],
      ['BLOCK_LINK_CLEARED'],
    ],
  ])('repairs %s exactly as the full merge does', (_label, base, fromAlice, fromBob, expected) => {
    const origin = createSharedDocument(base, TEST_DOCUMENT_ID);
    const alice = sessionOn(origin, 1);
    const bob = sessionOn(origin, 2);
    expect(alice.applyAll(fromAlice).ok).toBe(true);
    const reference = sessionOn(alice.document, 3).document;
    const before = Y.encodeStateVector(bob.document);
    expect(bob.applyAll(fromBob).ok).toBe(true);
    const update = Y.encodeStateAsUpdate(bob.document, before);
    const merged = alice.merge(update);
    expect(merged).toEqual(mergeSharedUpdate(reference, update));
    expect(merged.ok && merged.value.map((repair) => repair.code)).toEqual(expected);
  });

  it(
    'never throws on an honest update with one byte changed, refusing it intact or keeping a valid project',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const origin = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
      const honest = renameUpdate(sessionOn(origin, 9), 'a', 'Honest name');
      fc.assert(
        fc.property(
          fc.nat({ max: honest.length - 1 }),
          fc.integer({ min: 0, max: 255 }),
          (index, value) => {
            const altered = Uint8Array.from(honest);
            altered[index] = value;
            const session = sessionOn(origin, 1);
            const data = readSharedData(session.document);
            const merged = session.merge(altered);
            if (merged.ok) {
              expect(readSharedProject(session.document).ok).toBe(true);
              expect(session.project()).toEqual(unwrapProject(session.document));
            } else {
              expect(readSharedData(session.document)).toEqual(data);
            }
          },
        ),
      );
    },
  );
});

/** Reads the project of a document, failing the test when it is not valid. */
function unwrapProject(document: Y.Doc) {
  const read = readSharedProject(document);
  if (!read.ok) {
    throw new Error(JSON.stringify(read.error));
  }
  return read.value;
}
