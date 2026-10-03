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
  '40e6eb1106b459db49a247f83509bc798ae47e2260b5e3a7e4b06c990a3266de';
const AMERICAN_EXPORT_FINGERPRINT =
  'fc344561d9e0df30e5aa5befd59ff328f791c9935617be7349f8e548959ae206';
const IMPORT_DATES_FINGERPRINT = 'a1f9befb650dd4a5313636c8626e4dfbc72ead31714ee1e9202dcdbe5f0512c4';
const IMPORT_FINGERPRINT = 'b005cecef0cf7beeafeb0c453e758cf71b931fe8b53269560190bd906400a891';
const MESSY_IMPORT_DATES_FINGERPRINT =
  'c36f6b8553ad75f300860eb995159d72aace61535640121e373e215f98f7382b';
const CONSTRAINED_EXPORT_FINGERPRINT =
  '9b0dcd45085ffb3fd77b2e911d1d6283cbd8200fa7da0094817407b79034732f';
const CONSTRAINED_IMPORT_DATES_FINGERPRINT =
  'ff48fd17c33078c22e229c81c4662f3643da5d962dfbe3218deb45263248e9ba';
const CONSTRAINED_IMPORT_FINGERPRINT =
  '515083ab422df84df214156b88aeb782148ffc372a18390a7c8989291d39afac';
const CONSTRAINED_KEPT_STARTS = 276;
const MESSY_IMPORT_FINGERPRINT = 'c8d10c5376e79a02931487bbd949c0a408399757c2666cb2f52de39629ce78f6';

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
