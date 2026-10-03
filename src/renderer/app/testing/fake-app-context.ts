import * as Y from 'yjs';
import type { Project } from '../../../core/model/project';
import { scheduleProject } from '../../../core/scheduling/schedule-project';
import { createSharedDocument } from '../../../core/shared/shared-document';
import { TEST_DOCUMENT_ID } from '../../../core/testing/project-builder';
import type {
  BridgeResult,
  ExchangeKind,
  ExportedFile,
  OpenedProject,
  RecentProject,
  SavedProject,
  TasklaceBridge,
} from '../../../preload/bridge-contract';
import english from '../../locales/en.json';
import type { Scheduler, ScheduleListener } from '../../schedule/scheduler';
import { SAND_GRAPHITE } from '../../theme/sand-graphite';
import type { AppContext } from '../app-state.svelte';

export const OPENED_DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
export const FRENCH_FORMAT = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
} as const;
export const FIXED_NOW = new Date(2026, 8, 28, 10);

const SAVED: BridgeResult<SavedProject> = { ok: true, value: { localCopySaved: true } };

export interface FakeBridgeControl {
  openResult: BridgeResult<OpenedProject>;
  saveResult: BridgeResult<SavedProject> | Error;
  saveAsResult: BridgeResult<SavedProject>;
  exportResult: BridgeResult<ExportedFile>;
  adoptResult: BridgeResult<null>;
  recent: readonly RecentProject[] | Error | 'unreadable';
  newDocumentId: string;
  readonly calls: string[];
  readonly adopted: string[];
  readonly imports: ExchangeKind[];
  readonly exports: { readonly kind: ExchangeKind; readonly text: string; readonly name: string }[];
}

export interface ManualScheduler {
  readonly listener: () => ScheduleListener;
  readonly requests: Project[];
  automatic: boolean;
}

/** Describes a project as the main process gives it when a file is opened. */
export function openedProjectOf(
  project: Project,
  overrides: Partial<OpenedProject> = {},
): BridgeResult<OpenedProject> {
  const state = Y.encodeStateAsUpdate(createSharedDocument(project, OPENED_DOCUMENT_ID));
  return {
    ok: true,
    value: {
      state,
      documentId: OPENED_DOCUMENT_ID,
      name: project.name,
      fileName: `${project.name}.tasklace`,
      warnings: [],
      ...overrides,
    },
  };
}

/** Builds a bridge to a fake main process whose answers a test controls, recording the requests it receives. */
export function fakeBridge(): {
  readonly bridge: TasklaceBridge;
  readonly control: FakeBridgeControl;
} {
  const control: FakeBridgeControl = {
    openResult: { ok: false, error: { code: 'CANCELLED' } },
    saveResult: SAVED,
    saveAsResult: SAVED,
    exportResult: { ok: true, value: { fileName: 'plan.json' } },
    adoptResult: { ok: true, value: null },
    recent: [],
    newDocumentId: TEST_DOCUMENT_ID,
    calls: [],
    adopted: [],
    imports: [],
    exports: [],
  };
  const called = <T>(name: string, value: T): Promise<T> => {
    control.calls.push(name);
    return Promise.resolve(value);
  };
  const bridge: TasklaceBridge = {
    appVersion: () => called('appVersion', '1.0.0'),
    openExternal: () => called('openExternal', true),
    regionalFormat: () => called('regionalFormat', FRENCH_FORMAT),
    newProject: () => called('newProject', control.newDocumentId),
    openProject: () => called('openProject', control.openResult),
    openRecentProject: () => called('openRecentProject', control.openResult),
    recentProjects: () => {
      const { recent } = control;
      if (recent instanceof Error) {
        return Promise.reject(recent);
      }
      return called(
        'recentProjects',
        recent === 'unreadable'
          ? { ok: false, error: { code: 'READ_FAILED' } }
          : { ok: true, value: recent },
      );
    },
    importProject: (kind) => {
      control.imports.push(kind);
      return called('importProject', control.openResult);
    },
    adoptProject: (documentId) => {
      control.adopted.push(documentId);
      return called('adoptProject', control.adoptResult);
    },
    saveProject: () => {
      const { saveResult } = control;
      return saveResult instanceof Error
        ? Promise.reject(saveResult)
        : called('saveProject', saveResult);
    },
    saveProjectAs: () => called('saveProjectAs', control.saveAsResult),
    exportProject: (kind, text, name) => {
      control.exports.push({ kind, text, name });
      return called('exportProject', control.exportResult);
    },
    onFlushRequested: () => undefined,
    reportStartFailure: () => undefined,
  };
  return { bridge, control };
}

/** Builds a scheduler that computes schedules at once, or only records requests when told to stop being automatic. */
export function manualScheduler(): {
  readonly create: (listener: ScheduleListener) => Scheduler;
  readonly scheduler: ManualScheduler;
} {
  let current: ScheduleListener | null = null;
  const scheduler: ManualScheduler = {
    listener: () => {
      if (current === null) {
        throw new Error('No scheduler was created');
      }
      return current;
    },
    requests: [],
    automatic: true,
  };
  const create = (listener: ScheduleListener): Scheduler => {
    current = listener;
    return {
      request: (project) => {
        scheduler.requests.push(project);
        if (scheduler.automatic) {
          listener.scheduled(scheduleProject(project), project);
        }
      },
      dispose: () => undefined,
    };
  };
  return { create, scheduler };
}

/** Builds the context of the application state around a fake bridge and an immediate scheduler, with fixed identifiers and time. */
export function fakeAppContext() {
  const { bridge, control } = fakeBridge();
  const { create, scheduler } = manualScheduler();
  let nextId = 0;
  const context: AppContext = {
    bridge,
    messages: english,
    locale: 'en-US',
    createScheduler: create,
    createId: () => {
      nextId += 1;
      return `id${String(nextId)}`;
    },
    now: () => FIXED_NOW,
    theme: SAND_GRAPHITE,
  };
  return { context, control, scheduler };
}

/** Waits one turn of the event loop, so that every pending promise callback has run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
