import { exportProjectCsv } from '../../core/exchange/csv/project-csv-export';
import { exportProjectJson } from '../../core/exchange/project-json';
import type { Project, TaskId } from '../../core/model/project';
import type { Result } from '../../core/result';
import {
  scheduleProject,
  type Schedule,
  type SchedulingFailure,
} from '../../core/scheduling/schedule-project';
import type { SharedSession } from '../../core/shared/shared-session';
import type {
  BridgeResult,
  ExchangeKind,
  RecentProject,
  TasklaceBridge,
} from '../../preload/bridge-contract';
import { countMessage, fileErrorMessage, type Messages } from '../i18n/messages';
import { buildNewProject } from '../project/new-project';
import {
  createProjectFiles,
  FileActionError,
  type OpenedSession,
  type ProjectFiles,
  type SaveStatus,
} from '../project/project-files';
import type { ZoomLevel } from '../plan/time-scale';
import type { Scheduler, ScheduleListener } from '../schedule/scheduler';
import type { Theme } from '../theme/theme';
import type { Command } from './shortcuts';

export type NoticeKind = 'error' | 'warning';

export interface Notice {
  readonly id: number;
  readonly kind: NoticeKind;
  readonly text: string;
}

export interface AppContext {
  readonly bridge: TasklaceBridge;
  readonly messages: Messages;
  readonly locale: string;
  readonly createScheduler: (listener: ScheduleListener) => Scheduler;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly theme: Theme;
}

/** Holds what the interface shows: the open project, its schedule, whether it is saved, what can be undone and the messages for the user. */
export class AppState {
  project = $state.raw<Project | null>(null);
  schedule = $state.raw<Schedule | null>(null);
  saveStatus = $state<SaveStatus>('saved');
  hasFile = $state(false);
  canUndo = $state(false);
  canRedo = $state(false);
  recentProjects = $state.raw<readonly RecentProject[]>([]);
  notices = $state.raw<readonly Notice[]>([]);
  zoom = $state<ZoomLevel>('day');
  selectedTaskId = $state<TaskId | null>(null);
  openedCount = $state(0);

  readonly messages: Messages;
  readonly locale: string;
  readonly theme: Theme;
  readonly #context: AppContext;
  readonly #files: ProjectFiles;
  readonly #scheduler: Scheduler;
  #session: SharedSession | null = null;
  #refreshQueued = false;
  #nextNoticeId = 0;

  /** Creates the state of the interface around the bridge to the main process and a schedule worker. */
  constructor(context: AppContext) {
    this.#context = context;
    this.messages = context.messages;
    this.locale = context.locale;
    this.theme = context.theme;
    this.#files = createProjectFiles(context.bridge, {
      failed: (error) => {
        this.#reportError(error);
      },
      saveStatus: (status) => {
        this.saveStatus = status;
      },
    });
    this.#scheduler = context.createScheduler({
      scheduled: (result, project) => {
        this.#showSchedule(result, project);
      },
      failed: () => {
        this.#notify('error', this.messages.notices.scheduleFailed);
      },
    });
  }

  /** Loads the list of recent projects. */
  async loadRecentProjects(): Promise<void> {
    this.recentProjects = await this.#context.bridge.recentProjects();
  }

  /** Runs the action of a keyboard shortcut. */
  run(command: Command): Promise<void> {
    const actions: Readonly<Record<Command, () => Promise<void>>> = {
      newProject: () => this.newProject(),
      open: () => this.open(),
      save: () => this.save(),
      saveAs: () => this.saveAs(),
      undo: () => {
        this.undo();
        return Promise.resolve();
      },
      redo: () => {
        this.redo();
        return Promise.resolve();
      },
    };
    return actions[command]();
  }

  /** Starts a new empty project. */
  async newProject(): Promise<void> {
    const { messages, createId, now } = this.#context;
    const project = buildNewProject(messages.projects.untitled, now(), createId);
    this.#attach(await this.#files.create(project));
  }

  /** Asks for a project file and opens it. */
  async open(): Promise<void> {
    await this.#load(this.#files.open());
  }

  /** Opens one of the recent projects. */
  async openRecent(index: number): Promise<void> {
    await this.#load(this.#files.openRecent(index));
  }

  /** Asks for a CSV or JSON file and imports it as a new project. */
  async importFile(kind: ExchangeKind): Promise<void> {
    await this.#load(this.#files.importFile(kind));
  }

  /** Saves the project to its file, asking where for a project that has none yet. */
  async save(): Promise<void> {
    this.#showResult(await this.#files.save());
    this.hasFile = this.#files.hasFile();
    await this.loadRecentProjects();
  }

  /** Asks where to save the project, then saves it there. */
  async saveAs(): Promise<void> {
    this.#showResult(await this.#files.saveAs());
    this.hasFile = this.#files.hasFile();
    await this.loadRecentProjects();
  }

  /** Writes the project as a CSV table or a JSON file where the user chooses. */
  async exportFile(kind: ExchangeKind): Promise<void> {
    const project = this.project;
    if (project === null) {
      return;
    }
    const text = kind === 'json' ? exportProjectJson(project) : await this.#csvText(project);
    if (text !== null) {
      this.#showResult(await this.#context.bridge.exportProject(kind, text));
    }
  }

  /** Renames the project, telling whether the name was accepted. */
  rename(name: string): boolean {
    const trimmed = name.trim();
    const session = this.#session;
    if (session === null || trimmed === '' || trimmed === this.project?.name) {
      return false;
    }
    return session.apply({ type: 'updateProject', fields: { name: trimmed } }).ok;
  }

  /** Undoes the latest local change. */
  undo(): void {
    const undone = this.#session?.history.undo();
    if (undone?.ok === true) {
      this.#notifyRepairs(undone.value.length);
    }
  }

  /** Redoes the latest undone change. */
  redo(): void {
    const redone = this.#session?.history.redo();
    if (redone?.ok === true) {
      this.#notifyRepairs(redone.value.length);
    }
  }

  /** Saves at once what is not saved yet, before the window closes. */
  flush(): Promise<void> {
    return this.#files.flush();
  }

  /** Removes a message. */
  dismiss(id: number): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
  }

  /** Shows a project read from a file, with its warnings, or why it could not be read. */
  async #load(opening: Promise<BridgeResult<OpenedSession>>): Promise<void> {
    const opened = await opening;
    if (!opened.ok) {
      this.#showResult(opened);
      return;
    }
    this.#attach(opened.value.session);
    const warnings = opened.value.warnings.length;
    if (warnings > 0) {
      this.#notify(
        'warning',
        countMessage(this.messages.notices.importWarnings, warnings, this.locale),
      );
    }
    this.#notifyRepairs(opened.value.session.openingRepairs.length);
    await this.loadRecentProjects();
  }

  /** Follows the changes of a newly opened project. */
  #attach(session: SharedSession): void {
    this.#session?.document.off('update', this.#queueRefresh);
    this.#session = session;
    this.schedule = null;
    this.selectedTaskId = null;
    this.openedCount += 1;
    session.document.on('update', this.#queueRefresh);
    this.#refresh();
  }

  readonly #queueRefresh = (): void => {
    if (this.#refreshQueued) {
      return;
    }
    this.#refreshQueued = true;
    queueMicrotask(() => {
      this.#refreshQueued = false;
      this.#refresh();
    });
  };

  /** Reads the project of the session once for all the changes of a moment, and asks for its schedule. */
  #refresh(): void {
    const session = this.#session;
    if (session === null) {
      return;
    }
    this.project = session.project();
    this.hasFile = this.#files.hasFile();
    this.canUndo = session.history.canUndo();
    this.canRedo = session.history.canRedo();
    this.#scheduler.request(this.project);
  }

  /** Shows a computed schedule if it still belongs to the open project. */
  #showSchedule(result: Result<Schedule, SchedulingFailure>, project: Project): void {
    if (project !== this.project) {
      return;
    }
    if (!result.ok) {
      this.schedule = null;
      this.#notify('error', this.messages.notices.scheduleFailed);
      return;
    }
    this.schedule = result.value;
  }

  /** Computes the CSV table of a project in the regional format of the system. */
  async #csvText(project: Project): Promise<string | null> {
    const schedule = scheduleProject(project);
    if (!schedule.ok) {
      this.#notify('error', this.messages.notices.scheduleFailed);
      return null;
    }
    const format = await this.#context.bridge.regionalFormat();
    const text = exportProjectCsv(project, schedule.value, format);
    return text.ok ? text.value : null;
  }

  /** Tells the user why a file action failed, a cancelled action needing no message. */
  #showResult(result: BridgeResult<unknown>): void {
    if (result.ok) {
      return;
    }
    const text = fileErrorMessage(this.messages, result.error.code);
    if (text !== null) {
      this.#notify('error', text);
    }
  }

  /** Tells the user that changes were adjusted to keep the project valid. */
  #notifyRepairs(count: number): void {
    if (count > 0) {
      this.#notify('warning', countMessage(this.messages.notices.repairs, count, this.locale));
    }
  }

  /** Shows the failure of an action the user did not start, such as an automatic save. */
  #reportError(error: unknown): void {
    if (error instanceof FileActionError) {
      this.#showResult({ ok: false, error: error.failure });
      return;
    }
    this.#notify('error', this.messages.fileErrors.TASK_FAILED);
    console.error(error);
  }

  /** Adds a message, once only when the same message is already shown. */
  #notify(kind: NoticeKind, text: string): void {
    if (this.notices.some((notice) => notice.text === text)) {
      return;
    }
    this.#nextNoticeId += 1;
    this.notices = [...this.notices, { id: this.#nextNoticeId, kind, text }];
  }
}
