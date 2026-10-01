import { DEFAULT_CALENDAR } from '../../src/core/calendar/default-calendar';
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
  '30d80f79b50c888df49907def2726a2fb20e20a6f12e14c2905982e60352f3d1';
const AMERICAN_EXPORT_FINGERPRINT =
  '7a7a9d9c0ca828bb8040dd4469bca06ecf11ce3117049b37e12ceb0399eeef07';
const IMPORT_DATES_FINGERPRINT = 'a31ab59bd6b29cf232aac19c630a6f47ee71c41205e8c87c6c348de268669972';
const IMPORT_FINGERPRINT = 'aa898cbc0f446f93498751f944fb828669f513e44a3ad5c2f01ab52cfa69b985';
const MESSY_IMPORT_DATES_FINGERPRINT =
  '3fdbee79e22e9ed9e3741672b592575f2248ba1d9c6974af5bc8aaae9adfc842';
const CONSTRAINED_EXPORT_FINGERPRINT =
  'd0212266c3ce8f7afd9f9d79361a50c29f7a04b7426ab5ef96dd006ec61182e0';
const CONSTRAINED_IMPORT_DATES_FINGERPRINT =
  '951adfb1b0956f5ba7a513f03b067693f753b6780f32e7da06e1ee455da8d411';
const CONSTRAINED_IMPORT_FINGERPRINT =
  '6996054ae34cbbc8ffa101b5591544eaffdfb64106ea745ab6ef075a709f7fc6';
const CONSTRAINED_KEPT_STARTS = 266;
const MESSY_IMPORT_FINGERPRINT = '3a7353008d691dfd9e1b9652f758181bb8ff7be724128cb0831083719515a692';

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

/** Builds the large project with the calendar of imported projects, since a table does not carry its calendar. */
function csvProject(): Project {
  return { ...buildLargeProject(), calendar: DEFAULT_CALENDAR };
}

/** Builds the large project with tasks grouped under summaries and one task in seven given a start date later than its computed start, spread over its dependency chains. */
function constrainedProject(): Project {
  const base = csvProject();
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
  const project = csvProject();
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
