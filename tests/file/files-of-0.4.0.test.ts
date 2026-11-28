import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { canonicalCalendar } from '../../src/core/calendar/canonical-calendar';
import { compareStrings } from '../../src/core/compare-strings';
import { importProjectJson } from '../../src/core/exchange/project-json';
import {
  checkStateToSave,
  encodeTasklaceState,
  readTasklaceDocument,
  readTasklaceFile,
} from '../../src/core/file/tasklace-file';
import type { Project } from '../../src/core/model/project';
import { scheduleProject } from '../../src/core/scheduling/schedule-project';
import { readFormatVersion } from '../../src/core/shared/shared-document';
import { readSharedProject } from '../../src/core/shared/shared-project';
import { openTasklaceFile } from '../../src/core/testing/open-tasklace-file';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { LIVED_FILE_OF_0_4_0, RICH_FILE_OF_0_4_0, RICH_JSON_OF_0_4_0 } from './files-of-0.4.0';

const RICH = new Uint8Array(Buffer.from(RICH_FILE_OF_0_4_0, 'base64'));
const LIVED = new Uint8Array(Buffer.from(LIVED_FILE_OF_0_4_0, 'base64'));

/** Gives the SHA-256 fingerprint of bytes or text in hexadecimal. */
function fingerprintOf(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Reads a file of version 0.4.0 into the project it holds, failing the test when it cannot be read. */
function projectOf(file: Uint8Array): Project {
  const read = readTasklaceFile(file, zlibCompressor);
  const project = read.ok ? readSharedProject(read.value) : null;
  if (project === null || !project.ok) {
    throw new Error('A file of version 0.4.0 could not be read.');
  }
  return project.value;
}

/** Orders the lists of a project by identifier and writes its calendar as a shared document holds it. */
function sorted(input: Project): Project {
  /** Returns items ordered by identifier. */
  const byId = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
    [...items].sort((left, right) => compareStrings(left.id, right.id));
  return {
    ...input,
    calendar: canonicalCalendar(input.calendar),
    tasks: byId(input.tasks),
    dependencies: byId(input.dependencies),
    tags: byId(input.tags),
  };
}

describe('the files written by Tasklace 0.4.0', () => {
  it('are kept exactly as version 0.4.0 wrote them', () => {
    expect([fingerprintOf(RICH), fingerprintOf(LIVED), fingerprintOf(RICH_JSON_OF_0_4_0)]).toEqual([
      '233ac45e4ef3ce5ccc1d5b9defc11ce85ad5100d29015272b20a24d1858865c8',
      'ae4ade71d6f16dedd0d8e76f51e5530a9db635f682b5147e9e7f0db1351220b4',
      '9d1c7102f329ff16e395319ba9b4c633f807815a29e92605f2de5c29809a6728',
    ]);
  });

  it('hold no format version, as version 0.4.0 wrote none, and open as the first version', () => {
    for (const file of [RICH, LIVED]) {
      const read = readTasklaceFile(file, zlibCompressor);
      expect(
        read.ok && [
          read.value.getMap('project').has('formatVersion'),
          readFormatVersion(read.value),
        ],
      ).toEqual([false, 'known']);
    }
  });

  it('open the rich plan as the project its version 1 JSON export holds, with the same schedule', () => {
    const fromFile = projectOf(RICH);
    const fromJson = importProjectJson(RICH_JSON_OF_0_4_0);
    expect(RICH_JSON_OF_0_4_0.startsWith('{"format":"tasklace","version":1,')).toBe(true);
    expect(fromJson.ok && sorted(fromJson.value)).toEqual(fromFile);
    expect(fromJson.ok && scheduleProject(fromJson.value)).toEqual(scheduleProject(fromFile));
    expect([
      fromFile.name,
      fromFile.tasks.length,
      fromFile.dependencies.map(({ predecessorBlock, successorBlock }) => [
        predecessorBlock,
        successorBlock,
      ]),
      fromFile.tags.length,
      fromFile.baseline?.entries.length,
      fromFile.calendar.nonWorkingPeriods.length,
      Object.values(fromFile.options),
      scheduleProject(fromFile).ok,
    ]).toEqual([
      'Release plan 0.4.0',
      6,
      [
        [1, null],
        [null, null],
        [null, null],
        [null, 1],
      ],
      2,
      3,
      1,
      [true, true, true, true],
      true,
    ]);
  });

  it('open the plan that lived with its last changes, removed tasks, links and tags staying away', () => {
    const lived = projectOf(LIVED);
    expect([
      lived.name,
      lived.tasks
        .map(({ name }) => name)
        .filter((name) => name.startsWith('Extra') || name.startsWith('Ship')),
      lived.dependencies.length,
      lived.tags.map(({ name }) => name),
    ]).toEqual([
      'Lived plan',
      ['Extra 1', 'Extra 3', 'Extra 4', 'Ship it'],
      5,
      ['Documentation', 'Léa'],
    ]);
  });

  it('open as sessions that change, undo and save in the current format, the saved file opening again', () => {
    for (const file of [RICH, LIVED]) {
      const opened = openTasklaceFile(file, zlibCompressor);
      if (!opened.ok) {
        throw new Error('A file of version 0.4.0 did not open as a session.');
      }
      const session = opened.value;
      const [first] = session.project().tasks;
      if (first === undefined) {
        throw new Error('A file of version 0.4.0 holds no task.');
      }
      expect(session.apply({ type: 'putTask', task: { ...first, name: 'Renamed' } }).ok).toBe(true);
      const read = readTasklaceDocument(file, zlibCompressor);
      const documentId = read.ok ? read.value.documentId : null;
      const state = session.encodeState();
      const saved = encodeTasklaceState(state, zlibCompressor);
      expect([
        documentId !== null && checkStateToSave(state, documentId).ok,
        projectOf(saved).tasks.find(({ id }) => id === first.id)?.name,
        session.history.undo().ok,
        session.project().tasks.find(({ id }) => id === first.id)?.name,
      ]).toEqual([true, 'Renamed', true, first.name]);
    }
  });

  it('still merge with a copy of themselves kept elsewhere, as a shared plan would', () => {
    const read = readTasklaceFile(LIVED, zlibCompressor);
    const opened = openTasklaceFile(LIVED, zlibCompressor);
    if (!read.ok || !opened.ok) {
      throw new Error('The plan that lived did not open.');
    }
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(read.value));
    const before = Y.encodeStateVector(copy);
    copy.getMap('project').set('name', 'Renamed elsewhere');
    expect(opened.value.merge(Y.encodeStateAsUpdate(copy, before)).ok).toBe(true);
    expect(opened.value.project().name).toBe('Renamed elsewhere');
  });
});
