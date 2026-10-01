import { compileCalendar } from '../../core/calendar/compile-calendar';
import { exportProjectCsv } from '../../core/exchange/csv/project-csv-export';
import type { RegionalFormat } from '../../core/exchange/csv/regional-format';
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
import { createDayFormatter } from '../i18n/format';
import {
  countMessage,
  editErrorMessage,
  fileErrorMessage,
  fillMessage,
  type Messages,
} from '../i18n/messages';
import type { EditableColumn } from '../plan/cell-editing';
import {
  buildPlanOutline,
  NOTHING_COLLAPSED,
  predecessorText,
  toggledSummary,
} from '../plan/plan-outline';
import { taskBasis, taskFromDraft, type TaskDraft } from '../plan/task-details';
import {
  deleteTasks,
  insertTask,
  findBlockWaitProblem,
  replaceTask,
  type Edit,
  type EditContext,
} from '../plan/task-commands';
import type { SharedOperation } from '../../core/shared/shared-operations';
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

export type NoticeKind = 'error' | 'warning' | 'info';

export type CloseChoice = 'save' | 'discard' | 'cancel';

export interface ClosePrompt {
  readonly answer: (choice: CloseChoice) => void;
}

export interface EditRequest {
  readonly taskId: TaskId;
  readonly column: EditableColumn;
}

const DEFAULT_DAY_HOURS = 9;
const DEFAULT_TABLE_FORMAT: RegionalFormat = {
  listSeparator: ',',
  dateOrder: 'yearMonthDay',
  dateSeparator: '-',
  twelveHourClock: false,
};

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
  editRequest = $state<EditRequest | null>(null);
  detailsTaskId = $state<TaskId | null>(null);
  closePrompt = $state.raw<ClosePrompt | null>(null);
  collapsed = $state.raw<ReadonlySet<TaskId>>(NOTHING_COLLAPSED);
  openedCount = $state(0);
  regionalFormat = $state.raw<RegionalFormat>(DEFAULT_TABLE_FORMAT);
  readonly outline = $derived(buildPlanOutline(this.project?.tasks ?? [], this.collapsed));
  readonly calendar = $derived.by(() => {
    const compiled = this.project === null ? null : compileCalendar(this.project.calendar);
    return compiled?.ok === true ? compiled.value : null;
  });

  readonly messages: Messages;
  readonly locale: string;
  readonly theme: Theme;
  readonly #context: AppContext;
  readonly #files: ProjectFiles;
  readonly #scheduler: Scheduler;
  #session: SharedSession | null = null;
  #refreshQueued = false;
  #changedSinceOpened = false;
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

  /** Reads the regional format of the system, used to read the dates typed in the table. */
  async loadRegionalFormat(): Promise<void> {
    this.regionalFormat = await this.#context.bridge.regionalFormat();
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

  /** Asks whether to save a changed project that has no file yet before it is closed, telling whether it may be closed. */
  async readyToClose(): Promise<boolean> {
    if (this.project === null || this.hasFile || !this.#changedSinceOpened) {
      return true;
    }
    const choice = await new Promise<CloseChoice>((answer) => {
      this.closePrompt = { answer };
    });
    this.closePrompt = null;
    if (choice === 'save') {
      await this.saveAs();
      return this.hasFile;
    }
    return choice === 'discard';
  }

  /** Starts a new empty project. */
  async newProject(): Promise<void> {
    if (!(await this.readyToClose())) {
      return;
    }
    const { messages, createId, now } = this.#context;
    const project = buildNewProject(messages.projects.untitled, now(), createId);
    this.#attach(await this.#files.create(project));
  }

  /** Asks for a project file and opens it. */
  async open(): Promise<void> {
    if (await this.readyToClose()) {
      await this.#load(this.#files.open());
    }
  }

  /** Opens one of the recent projects. */
  async openRecent(index: number): Promise<void> {
    if (await this.readyToClose()) {
      await this.#load(this.#files.openRecent(index));
    }
  }

  /** Asks for a CSV or JSON file and imports it as a new project. */
  async importFile(kind: ExchangeKind): Promise<void> {
    if (await this.readyToClose()) {
      await this.#load(this.#files.importFile(kind));
    }
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

  /** Opens or closes a summary task. */
  toggleSummary(id: TaskId): void {
    this.collapsed = toggledSummary(this.collapsed, id);
  }

  /** Applies a change built from the current project, telling the user why when it is refused. */
  edit(build: (context: EditContext) => Edit): boolean {
    const refusal = this.tryEdit(build);
    if (refusal !== null) {
      this.#notify('error', refusal);
    }
    return refusal === null;
  }

  /** Applies a change built from the current project, returning why it was refused, or null once applied. */
  tryEdit(
    build: (context: EditContext) => Result<readonly SharedOperation[], string>,
  ): string | null {
    const session = this.#session;
    const project = this.project;
    if (session === null || project === null) {
      return editErrorMessage(this.messages, 'NOT_POSSIBLE');
    }
    const edit = build(this.#editContext(project));
    if (!edit.ok) {
      return editErrorMessage(this.messages, edit.error);
    }
    const applied = session.applyAll(edit.value);
    if (!applied.ok) {
      return editErrorMessage(this.messages, applied.error[0]?.code ?? '');
    }
    this.#refresh();
    this.#notifyStartMove(project.startDate);
    return null;
  }

  /** Opens the details panel of a task, or of the selected task. */
  openDetails(id: TaskId | null = this.selectedTaskId): void {
    if (id !== null) {
      this.selectedTaskId = id;
      this.detailsTaskId = id;
    }
  }

  /** Writes what a block of a task waits for, as in the task table. */
  blockWaitText(id: TaskId, block: number): string {
    const incoming = this.project?.dependencies.filter((link) => link.successorId === id);
    return predecessorText(incoming, this.outline.wbsById, block);
  }

  /** Describes a task and the links that touch it, so that the details panel can tell whether it changed while open. */
  detailsBasis(id: TaskId): string {
    const project = this.project;
    return project === null ? '' : taskBasis(project, id);
  }

  /** Applies the details panel to its task, returning why it was refused, or null once applied. */
  saveDetails(draft: TaskDraft): string | null {
    const id = this.detailsTaskId;
    const task = this.project?.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) {
      return editErrorMessage(this.messages, 'NOT_POSSIBLE');
    }
    if (draft.basis !== this.detailsBasis(task.id)) {
      return editErrorMessage(this.messages, 'TASK_CHANGED');
    }
    const blockProblem = this.project === null ? null : this.#blockWaitProblem(draft);
    if (blockProblem !== null) {
      return blockProblem;
    }
    const refusal = this.tryEdit((context) => {
      const built = taskFromDraft(task, draft, context.dayHours);
      return built.ok ? replaceTask(context, built.value, draft.blocks) : built;
    });
    if (refusal === null) {
      this.detailsTaskId = null;
    }
    return refusal;
  }

  /** Adds a task after the selected one, selects it and asks the table to edit its name. */
  addTask(): void {
    const session = this.#session;
    const project = this.project;
    if (session === null || project === null) {
      return;
    }
    const inserted = insertTask(
      this.#editContext(project),
      this.selectedTaskId,
      this.messages.table.newTask,
    );
    if (inserted.ok && this.edit(() => ({ ok: true, value: inserted.value.operations }))) {
      this.selectedTaskId = inserted.value.taskId;
      this.editRequest = { taskId: inserted.value.taskId, column: 'name' };
    }
  }

  /** Applies a change to the selected task, doing nothing when no task is selected. */
  editSelected(build: (context: EditContext, id: TaskId) => Edit): void {
    const id = this.selectedTaskId;
    if (id !== null) {
      this.edit((context) => build(context, id));
    }
  }

  /** Deletes the selected task and everything under it, then selects the row that takes its place. */
  deleteSelected(): void {
    const id = this.selectedTaskId;
    if (id === null) {
      return;
    }
    const index = this.outline.rowIndexById.get(id) ?? 0;
    if (this.edit((context) => deleteTasks(context, [id]))) {
      const rows = this.outline.rows;
      this.selectedTaskId = rows[Math.min(index, rows.length - 1)]?.task.id ?? null;
    }
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

  /** Returns what the editing commands need to know about the project. */
  #editContext(project: Project): EditContext {
    return {
      project,
      outline:
        project === this.project
          ? this.outline
          : buildPlanOutline(project.tasks, NOTHING_COLLAPSED),
      createId: this.#context.createId,
      dayHours: this.calendar?.workingHoursPerDay ?? DEFAULT_DAY_HOURS,
    };
  }

  /** Follows the changes of a newly opened project. */
  #attach(session: SharedSession): void {
    this.#session?.document.off('update', this.#queueRefresh);
    this.#session = session;
    this.schedule = null;
    this.selectedTaskId = null;
    this.editRequest = null;
    this.detailsTaskId = null;
    this.#changedSinceOpened = false;
    this.collapsed = NOTHING_COLLAPSED;
    this.openedCount += 1;
    session.document.on('update', this.#queueRefresh);
    this.#refresh();
  }

  readonly #queueRefresh = (): void => {
    this.#changedSinceOpened = true;
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
    const project = session.project();
    if (project === this.project) {
      return;
    }
    this.project = project;
    this.hasFile = this.#files.hasFile();
    this.canUndo = session.history.canUndo();
    this.canRedo = session.history.canRedo();
    this.#scheduler.request(project);
    if (this.selectedTaskId !== null && !this.outline.wbsById.has(this.selectedTaskId)) {
      this.selectedTaskId = null;
    }
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

  /** Tells which field of the details panel names a task or block that does not exist, or null. */
  #blockWaitProblem(draft: TaskDraft): string | null {
    const project = this.project;
    if (project === null || draft.blocks.length < 2) {
      return null;
    }
    const problem = findBlockWaitProblem(this.#editContext(project), draft.blocks);
    return problem === null
      ? null
      : fillMessage(this.messages.details.blockError, {
          number: String(problem.block + 1),
          message: editErrorMessage(this.messages, problem.error),
        });
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
    if (!text.ok) {
      this.#notify('error', this.messages.notices.exportFailed[text.error]);
      return null;
    }
    return text.value;
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

  /** Tells the user that the project now starts earlier, so that a task placed before it fits. */
  #notifyStartMove(previousStart: number): void {
    const start = this.project?.startDate;
    if (start !== undefined && start < previousStart) {
      const date = createDayFormatter(this.locale)(start);
      this.#notify('info', fillMessage(this.messages.notices.projectStartMoved, { date }));
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
