/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/core/model/project';
import { compileOrThrow } from '../../src/core/testing/civil-time';
import { scheduleOrThrow } from '../../src/core/testing/project-builder';
import { dayIndexOf } from '../../src/core/time';
import { loadMessages } from '../../src/renderer/i18n/messages';
import { buildPrintDocument, type PrintSource } from '../../src/renderer/print/print-pages';
import type { MeasureText } from '../../src/renderer/print/print-text';
import { SAND_GRAPHITE } from '../../src/renderer/theme/sand-graphite';
import { buildLargeProject, LARGE_PROJECT_SEED } from '../fixtures/large-project';
import {
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SMALL_TASK_COUNT,
} from './measure-growth';

const messages = await loadMessages('en');
const CHARACTER_WIDTH = 5;
const PRINTED_DAYS = 60;

/** Measures a text at a fixed width per character. */
const measure: MeasureText = (text) => text.length * CHARACTER_WIDTH;

/** Returns what printing needs from a project, its schedule worked out. */
function sourceOf(project: Project): PrintSource {
  return {
    project,
    schedule: scheduleOrThrow(project),
    calendar: compileOrThrow(project.calendar),
    theme: SAND_GRAPHITE,
    messages,
    locale: 'en-US',
    exportedAt: new Date(Date.UTC(2026, 9, 9)),
  };
}

describe('growth of printing a plan with its size', () => {
  it('draws every page of the same period in time linear in the rows, the links of each page included', () => {
    const small = sourceOf(buildLargeProject(LARGE_PROJECT_SEED, SMALL_TASK_COUNT));
    const large = sourceOf(buildLargeProject(LARGE_PROJECT_SEED, LARGE_TASK_COUNT));
    const firstDay = dayIndexOf(small.project.startDate);
    /** Prints every page of a project over the same days at the week zoom. */
    const print = (source: PrintSource) => () => {
      const result = buildPrintDocument(
        source,
        {
          paper: 'a3',
          orientation: 'landscape',
          period: { kind: 'days', firstDay, lastDay: firstDay + PRINTED_DAYS },
          zoom: 'week',
          columns: ['wbs', 'start', 'end'],
        },
        measure,
      );
      if (!result.ok) {
        throw new Error(result.error);
      }
    };
    const ratio = growthRatio(print(small), print(large));
    console.info(`Print pages: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
