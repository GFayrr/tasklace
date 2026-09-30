import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportProjectCsv } from '../../src/core/exchange/csv/project-csv-export';
import { importProjectCsv, type CsvImport } from '../../src/core/exchange/csv/project-csv-import';
import type { RegionalFormat } from '../../src/core/exchange/csv/regional-format';
import type { Project, Task } from '../../src/core/model/project';
import { scheduleProject } from '../../src/core/scheduling/schedule-project';
import { PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../../src/core/testing/arbitraries';
import { buildLargeProject } from './large-project';

const FRENCH: RegionalFormat = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
};
const AMERICAN: RegionalFormat = {
  listSeparator: ',',
  dateOrder: 'monthDayYear',
  dateSeparator: '/',
  twelveHourClock: true,
};
const BLANK_LINE_EVERY = 7;
const SEPARATOR_LINE_EVERY = 11;
const DATE_ONLY_EVERY = 5;
const DATE_AND_HOUR = /(\d{2}\/\d{2}\/\d{4}) \d{2}:00/;
const PHASE_COUNT = 10;
const IN_PHASE_EVERY = 3;
const START_DATE_EVERY = 7;
const START_DATE_DELAY_HOURS = 30;

const FRENCH_EXPORT_FINGERPRINT =
  '828360ccd3625f2d5bd8130aa6952cda1ecd4f8e43d981e98e0b0bf4ee02e2af';
const AMERICAN_EXPORT_FINGERPRINT =
  '55c66451fd9d58b8ee3e1e15d2dc72f8b17fc20191d58589d7ce39b976a3dd71';
const IMPORT_DATES_FINGERPRINT = 'a12cb6b3e3e8b47b6d1442416b37a0dbefc4da8dbe4f708149218831c1ec44a3';
const IMPORT_FINGERPRINT = 'fc40e054f85b00a5d911b7e668583723dc2904e804c835c74adac13b3d0d57ac';
const MESSY_IMPORT_DATES_FINGERPRINT =
  'd2e6e58499077dd17f1bae01c27600ab0c5400401762e487efaa89f8041dc68a';
const CONSTRAINED_EXPORT_FINGERPRINT =
  '6840ea54ca24828bc32046190294b121966664373c5fe046a0f3f6d3776c7dd4';
const CONSTRAINED_IMPORT_DATES_FINGERPRINT =
  '74330b137209469babf83e840b75748c1c16378c0eb4a00c82e18595afa75c76';
const CONSTRAINED_IMPORT_FINGERPRINT =
  '79dc15c8daafaa24dde9712643dbb64f713c5b393b451fe29706c6666532c8a1';
const CONSTRAINED_KEPT_STARTS = 277;
const MESSY_IMPORT_FINGERPRINT = '81f42904df458df6c0a537ba5912803d27ee0d4b6bd69bae87b4492e199d7184';

/** Returns the SHA-256 fingerprint of a value serialized as JSON. */
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Lists the placements, summaries and WBS numbers of the schedule of an import, maps being listed in their order. */
function importDates(imported: CsvImport) {
  return {
    placements: [...imported.schedule.placements],
    summaries: [...imported.schedule.summaries],
    wbsNumbers: [...imported.schedule.wbsNumbers],
  };
}

/** Rewrites an exported table as a person editing it in a spreadsheet might: blank and separator-only lines, an unknown column, a column without header holding notes, and the start date of one row in five without its hour. */
function messyTable(exported: string): string {
  const [header = '', ...rows] = exported.replace(/^﻿/, '').split('\r\n');
  const lines = rows
    .filter((row) => row !== '')
    .flatMap((row, index) => {
      const date = index % DATE_ONLY_EVERY === 0 ? row.replace(DATE_AND_HOUR, '$1') : row;
      const edited = `${date};owner ${String(index)};note`;
      const extra = [
        ...(index % BLANK_LINE_EVERY === 0 ? [''] : []),
        ...(index % SEPARATOR_LINE_EVERY === 0 ? [';;;; ;'] : []),
      ];
      return [edited, ...extra];
    });
  return [`${header};Owner;`, ...lines].join('\n');
}

/** Builds the large project with tasks grouped under summaries and one task in seven given a start date later than its computed start, spread over its dependency chains. */
function constrainedProject(): Project {
  const base = buildLargeProject();
  const placements = unwrap(scheduleProject(base)).placements;
  const phases = Array.from({ length: PHASE_COUNT }, (_unused, index): Task => ({
    kind: 'summary',
    id: `phase-${String(index)}`,
    name: `Phase ${String(index)}`,
    parentId: null,
    sortKey: `z${String(index)}`,
  }));
  const tasks = base.tasks.map((task, index): Task => {
    const parentId = index % IN_PHASE_EVERY === 0 ? `phase-${String(index % PHASE_COUNT)}` : null;
    const start = placements.get(task.id)?.start;
    if (task.kind === 'summary' || start === undefined || index % START_DATE_EVERY !== 0) {
      return { ...task, parentId };
    }
    return { ...task, parentId, startNoEarlierThan: start + START_DATE_DELAY_HOURS };
  });
  return { ...base, tasks: [...phases, ...tasks] };
}

describe('CSV exchange of the large project', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  const project = buildLargeProject();
  const schedule = unwrap(scheduleProject(project));
  const french = unwrap(exportProjectCsv(project, schedule, FRENCH));
  const options = { format: FRENCH, projectName: 'Imported', fallbackStart: project.startDate };

  it('exports exactly the same text on every machine', () => {
    expect(fingerprint(french)).toBe(FRENCH_EXPORT_FINGERPRINT);
    expect(fingerprint(unwrap(exportProjectCsv(project, schedule, AMERICAN)))).toBe(
      AMERICAN_EXPORT_FINGERPRINT,
    );
  });

  it('imports its export into exactly the same dates and project', () => {
    const imported = unwrap(importProjectCsv(french, options));
    expect(fingerprint(importDates(imported))).toBe(IMPORT_DATES_FINGERPRINT);
    expect(fingerprint({ project: imported.project, warnings: imported.warnings })).toBe(
      IMPORT_FINGERPRINT,
    );
  });

  it('imports a table edited by hand into exactly the same dates, project and warnings', () => {
    const imported = unwrap(importProjectCsv(messyTable(french), options));
    expect(fingerprint(importDates(imported))).toBe(MESSY_IMPORT_DATES_FINGERPRINT);
    expect(fingerprint({ project: imported.project, warnings: imported.warnings })).toBe(
      MESSY_IMPORT_FINGERPRINT,
    );
  });
});

describe(
  'CSV exchange of the large project with summaries and start dates',
  {
    timeout: PROPERTY_TEST_TIMEOUT_MS,
  },
  () => {
    const project = constrainedProject();
    const text = unwrap(exportProjectCsv(project, unwrap(scheduleProject(project)), FRENCH));
    const options = { format: FRENCH, projectName: 'Imported', fallbackStart: project.startDate };

    it('exports the same text and imports it into the same dates as main, keeping only the start dates they need', () => {
      expect(fingerprint(text)).toBe(CONSTRAINED_EXPORT_FINGERPRINT);
      const imported = unwrap(importProjectCsv(text, options));
      expect(fingerprint(importDates(imported))).toBe(CONSTRAINED_IMPORT_DATES_FINGERPRINT);
      const kept = imported.project.tasks.filter(
        (task) => task.kind !== 'summary' && task.startNoEarlierThan !== null,
      );
      expect(kept).toHaveLength(CONSTRAINED_KEPT_STARTS);
      expect(imported.schedule.summaries.size).toBe(PHASE_COUNT);
      expect(fingerprint({ project: imported.project, warnings: imported.warnings })).toBe(
        CONSTRAINED_IMPORT_FINGERPRINT,
      );
    });
  },
);
