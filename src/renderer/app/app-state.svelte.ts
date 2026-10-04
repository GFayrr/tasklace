import { compileCalendar } from '../../core/calendar/compile-calendar';
import { exportProjectCsv } from '../../core/exchange/csv/project-csv-export';
import { exportProjectJson } from '../../core/exchange/project-json';
import type { Project, TaskId } from '../../core/model/project';
import type { Result } from '../../core/result';
import type { MergeFailure, SharedRepair } from '../../core/shared/shared-project';
import { issueText, repairText, type ReportedIssue } from '../i18n/issue-text';
import { scheduleFailureText } from '../i18n/schedule-failure-text';
import { parseDuration } from '../plan/durations';
import {
  scheduleProject,
  type Schedule,
  type SchedulingFailure,
} from '../../core/scheduling/schedule-project';
import type { SharedSession } from '../../core/shared/shared-session';
import type { ExchangeKind, RecentProject, TasklaceBridge } from '../../preload/bridge-contract';
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
import {
  findUnreadableBlockStart,
  taskBasis,
  taskFromDraft,
  type TaskDraft,
  withAddedBlock,
} from '../plan/task-details';
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
  type ActionResult,
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

export type DrawingPart = 'timeline' | 'patterns';

export type ClosePrompt =
  | { readonly reason: 'unsaved'; readonly answer: (choice: CloseChoice) => void }
  | {
      readonly reason: 'saveFailed';
      readonly detail: string;
      readonly answer: (choice: CloseChoice) => void;
    };

type CloseQuestion =
  { readonly reason: 'unsaved' } | { readonly reason: 'saveFailed'; readonly detail: string };

type CloseDecision = 'proceed' | 'discarded' | 'cancelled';

export interface EditRequest {
  readonly taskId: TaskId;
  readonly column: EditableColumn;
}

export interface Report {
  readonly title: string;
  readonly entries: readonly string[];
}

export interface Notice {
  readonly id: number;
  readonly kind: NoticeKind;
  readonly text: string;
  readonly report: Report | null;
  readonly lasting: boolean;
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
  #closePrompt = $state.raw<ClosePrompt | null>(null);
  #fileActionRunning = $state(false);
  #report = $state.raw<Report | null>(null);
  #lastQuestion: Promise<unknown> = Promise.resolve();
  collapsed = $state.raw<ReadonlySet<TaskId>>(NOTHING_COLLAPSED);
  openedCount = $state(0);
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
  readonly #drawingProblems: Record<DrawingPart, boolean> = { timeline: false, patterns: false };

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
      localCopyFailed: () => {
        this.#notify('warning', this.messages.notices.localCopyFailed);
      },
      fileActionRunning: (running) => {
        this.#fileActionRunning = running;
      },
    });
    this.#scheduler = context.createScheduler({
      scheduled: (result, project) => {
        this.#showSchedule(result, project);
      },
      failed: (error) => {
        console.error('The schedule could not be computed:', error);
        this.#notify('error', this.messages.notices.scheduleStopped, null, true);
      },
    });
  }

  /** Returns the question about closing a project shown to the user, or null. */
  get closePrompt(): ClosePrompt | null {
    return this.#closePrompt;
  }

  /** Tells whether a file action started by the user runs, during which the project cannot be changed. */
  get fileActionRunning(): boolean {
    return this.#fileActionRunning;
  }

  /** Returns the detailed list behind a message shown to the user, or null. */
  get report(): Report | null {
    return this.#report;
  }

  /** Loads the list of recent projects, a list that cannot be loaded leaving the previous one and a warning, so that the action that asked for it still succeeds. */
  async loadRecentProjects(): Promise<void> {
    try {
      const loaded = await this.#context.bridge.recentProjects();
      if (loaded.ok) {
        this.recentProjects = loaded.value;
        return;
      }
      console.error('The recent projects could not be loaded:', loaded.error);
    } catch (error) {
      console.error('The recent projects could not be loaded:', error);
    }
    this.#notify('warning', this.messages.notices.recentUnavailable);
  }

  /** Runs the action of a keyboard shortcut. */
  run(command: Command): Promise<void> {
    const actions: Readonly<Record<Command, () => Promise<void>>> = {
      newProject: () => this.newProject(),
      open: () => this.open(),
      save: () => this.save(),
      saveAs: async () => {
        await this.saveAs();
      },
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
    return (await this.#closeDecision()) !== 'cancelled';
  }

  /** Prepares the window to close: asks about a project without file, closing at once when the user chooses not to save it, then saves, and when that save fails keeps the window open unless the user saves elsewhere or chooses to close without saving. */
  async prepareClose(): Promise<boolean> {
    const decision = await this.#closeDecision();
    if (decision !== 'proceed') {
      return decision === 'discarded';
    }
    try {
      await this.flush();
      return true;
    } catch (error) {
      if (!(error instanceof FileActionError)) {
        console.error('The project could not be saved before closing:', error);
      }
      const code = error instanceof FileActionError ? error.failure.code : 'TASK_FAILED';
      const detail = fileErrorMessage(this.messages, code) ?? this.messages.fileErrors.TASK_FAILED;
      const choice = await this.#ask({ reason: 'saveFailed', detail });
      return choice === 'save' ? this.saveAs() : choice === 'discard';
    }
  }

  /** Asks whether to save a changed project that has no file yet, telling whether to go on with saving, to close without saving, or to keep the project open. */
  async #closeDecision(): Promise<CloseDecision> {
    if (this.project === null || this.hasFile || !this.#changedSinceOpened) {
      return 'proceed';
    }
    const choice = await this.#ask({ reason: 'unsaved' });
    if (choice === 'save') {
      return (await this.saveAs()) ? 'proceed' : 'cancelled';
    }
    return choice === 'discard' ? 'discarded' : 'cancelled';
  }

  /** Shows a question about closing a project once the questions asked before it are answered, so that each question gets its own answer. */
  #ask(question: CloseQuestion): Promise<CloseChoice> {
    const asked = this.#lastQuestion
      .then(
        () =>
          new Promise<CloseChoice>((answer) => {
            this.#closePrompt = { ...question, answer };
          }),
      )
      .finally(() => {
        this.#closePrompt = null;
      });
    this.#lastQuestion = asked;
    return asked;
  }

  /** Tells whether the open project may be replaced: never while a file action runs, which is refused at once, and otherwise once the user agreed about a project without file. */
  async #readyToReplace(): Promise<boolean> {
    return !this.#refuseWhileFileActionRuns() && (await this.readyToClose());
  }

  /** Starts a new empty project. */
  async newProject(): Promise<void> {
    if (!(await this.#readyToReplace())) {
      return;
    }
    const { messages, createId, now } = this.#context;
    const project = buildNewProject(messages.projects.untitled, now(), createId);
    const created = await this.#files.create(project);
    if (!created.ok) {
      this.#showResult(created);
      return;
    }
    this.#attach(created.value);
  }

  /** Asks for a project file and opens it. */
  async open(): Promise<void> {
    if (await this.#readyToReplace()) {
      await this.#load(this.#files.open());
    }
  }

  /** Opens one of the recent projects. */
  async openRecent(index: number): Promise<void> {
    if (await this.#readyToReplace()) {
      await this.#load(this.#files.openRecent(index));
    }
  }

  /** Asks for a CSV or JSON file, imports it as a new project and tells how many tasks it brought. */
  async importFile(kind: ExchangeKind): Promise<void> {
    if (!(await this.#readyToReplace())) {
      return;
    }
    const imported = await this.#load(this.#files.importFile(kind));
    if (imported !== null) {
      const taskCount = imported.session.project().tasks.length;
      const counted = countMessage(this.messages.notices.imported, taskCount, this.locale);
      this.#notify('info', fillMessage(counted, { file: imported.fileName }));
    }
  }

  /** Saves the project to its file, asking where for a project that has none yet. */
  async save(): Promise<void> {
    this.#showResult(await this.#files.save());
    this.hasFile = this.#files.hasFile();
    await this.loadRecentProjects();
  }

  /** Asks where to save the project, then saves it there, telling whether it was saved. */
  async saveAs(): Promise<boolean> {
    const saved = await this.#files.saveAs();
    this.#showResult(saved);
    this.hasFile = this.#files.hasFile();
    await this.loadRecentProjects();
    return saved.ok;
  }

  /** Writes the project as a CSV table or a JSON file where the user chooses, suggesting the project name, and tells the name of the file written. */
  async exportFile(kind: ExchangeKind): Promise<void> {
    const project = this.project;
    if (project === null) {
      return;
    }
    const text = kind === 'json' ? exportProjectJson(project) : await this.#csvText(project);
    if (text === null) {
      return;
    }
    const exported = await this.#files.exportFile(kind, text, project.name);
    if (exported.ok) {
      this.#notify(
        'info',
        fillMessage(this.messages.notices.exported, { file: exported.value.fileName }),
      );
    }
    this.#showResult(exported);
  }

  /** Renames the project, telling whether the name was accepted and telling the user why when the project or a running file action refuses it. */
  rename(name: string): boolean {
    const trimmed = name.trim();
    const session = this.#session;
    if (session === null || trimmed === '' || trimmed === this.project?.name) {
      return false;
    }
    if (this.#refuseWhileFileActionRuns()) {
      return false;
    }
    const renamed = session.apply({ type: 'updateProject', fields: { name: trimmed } });
    if (!renamed.ok) {
      this.#notify('error', editErrorMessage(this.messages, renamed.error[0]?.code ?? ''));
    }
    return renamed.ok;
  }

  /** Opens or closes a summary task from the keyboard, doing nothing for a task that is not a summary or already in that state. */
  setSummaryOpen(id: TaskId, open: boolean): void {
    const isSummary = this.project?.tasks.some((task) => task.id === id && task.kind === 'summary');
    if (isSummary === true && this.collapsed.has(id) === open) {
      this.collapsed = toggledSummary(this.collapsed, id);
    }
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

  /** Applies a change built from the current project, returning why it was refused, as while a file action runs, or null once applied. */
  tryEdit(
    build: (context: EditContext) => Result<readonly SharedOperation[], string>,
  ): string | null {
    const session = this.#session;
    const project = this.project;
    if (session === null || project === null) {
      return editErrorMessage(this.messages, 'NOT_POSSIBLE');
    }
    if (this.#fileActionRunning) {
      return this.messages.fileErrors.BUSY;
    }
    const context = this.#editContext(project);
    if (context === null) {
      return editErrorMessage(this.messages, 'NOT_POSSIBLE');
    }
    const edit = build(context);
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
    const blockProblem = this.#blockProblem(draft);
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

  /** Adds a task after the selected one, selects it and asks the table to edit its name, telling the user when the project refuses it. */
  addTask(): void {
    const added: TaskId[] = [];
    const applied = this.edit((context) => {
      const inserted = insertTask(context, this.selectedTaskId, this.messages.table.newTask);
      added.push(inserted.taskId);
      return { ok: true, value: inserted.operations };
    });
    const [taskId] = added;
    if (applied && taskId !== undefined) {
      this.selectedTaskId = taskId;
      this.editRequest = { taskId, column: 'name' };
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

  /** Undoes the latest local change, unless a file action runs. */
  undo(): void {
    if (this.#refuseWhileFileActionRuns()) {
      return;
    }
    this.#showHistoryStep(this.#session?.history.undo(), this.messages.notices.undoFailed);
  }

  /** Redoes the latest undone change, unless a file action runs. */
  redo(): void {
    if (this.#refuseWhileFileActionRuns()) {
      return;
    }
    this.#showHistoryStep(this.#session?.history.redo(), this.messages.notices.redoFailed);
  }

  /** Tells the user that the project cannot change while a file action runs, telling whether one runs. */
  #refuseWhileFileActionRuns(): boolean {
    if (this.#fileActionRunning) {
      this.#notify('error', this.messages.fileErrors.BUSY);
    }
    return this.#fileActionRunning;
  }

  /** Tells the repairs an undone or redone step needed, or that the step could not be applied and the project was left as it was, logging why, a failed repair being an unexpected error. */
  #showHistoryStep(
    step: Result<readonly SharedRepair[], MergeFailure> | undefined,
    refusal: string,
  ): void {
    if (step === undefined) {
      return;
    }
    if (step.ok) {
      this.#notifyRepairs(step.value);
      return;
    }
    if (step.error.kind === 'repairFailed') {
      this.reportUnexpectedError(step.error.error);
      return;
    }
    console.error('The step could not be undone or redone:', step.error);
    this.#notify('warning', refusal);
  }

  /** Saves at once what is not saved yet, before the window closes. */
  flush(): Promise<void> {
    return this.#files.flush();
  }

  /** Tells the user that an action stopped on an unexpected error, which is logged for diagnosis. */
  reportUnexpectedError(error: unknown): void {
    console.error('Unexpected error:', error);
    this.#notify('error', this.messages.notices.unexpectedError);
  }

  /** Tells the user that the calendar to choose a date could not open, so the date has to be typed. */
  reportPickerUnavailable(error: unknown): void {
    console.error('The date picker could not open:', error);
    this.#notify('warning', this.messages.notices.pickerUnavailable);
  }

  /** Tells the user, once per part, that the timeline or the patterns of its bars cannot be drawn. */
  reportDrawingProblem(part: DrawingPart): void {
    if (this.#drawingProblems[part]) {
      return;
    }
    this.#drawingProblems[part] = true;
    console.error(`The ${part} could not be drawn: the canvas gave no drawing context or pattern.`);
    this.#notify('warning', this.messages.notices.drawingUnavailable[part]);
  }

  /** Shows the detailed list behind a message. */
  openReport(report: Report): void {
    this.#report = report;
  }

  /** Closes the detailed list of a message. */
  closeReport(): void {
    this.#report = null;
  }

  /** Removes a message. */
  dismiss(id: number): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
  }

  /** Shows a project read from a file, with its warnings and repairs, and returns it, or tells why it could not be read and returns null. */
  async #load(opening: Promise<ActionResult<OpenedSession>>): Promise<OpenedSession | null> {
    const opened = await opening;
    if (!opened.ok) {
      this.#showResult(opened);
      return null;
    }
    this.#attach(opened.value.session);
    const { warnings } = opened.value;
    if (warnings.length > 0) {
      this.#notify(
        'warning',
        countMessage(this.messages.notices.importWarnings, warnings.length, this.locale),
        this.#issueReport(this.messages.report.importWarnings, warnings),
      );
    }
    this.#notifyRepairs(opened.value.session.openingRepairs);
    await this.loadRecentProjects();
    return opened.value;
  }

  /** Returns what the editing commands need to know about the open project, or null, logged, when its calendar cannot be compiled, which the validation of every project rules out. */
  #editContext(project: Project): EditContext | null {
    if (this.calendar === null) {
      console.error('The calendar of the open project cannot be compiled; the change is refused.');
      return null;
    }
    return {
      project,
      outline: this.outline,
      createId: this.#context.createId,
      dayHours: this.calendar.workingHoursPerDay,
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
      this.#showScheduleFailure(result.error, project);
      return;
    }
    this.schedule = result.value;
  }

  /** Tells the user why the schedule of a project could not be computed, with each problem and the task it concerns, and logs the cause. */
  #showScheduleFailure(failure: SchedulingFailure, project: Project): void {
    console.error('The schedule could not be computed:', failure);
    const names: Readonly<Record<string, string>> = Object.fromEntries(
      project.tasks.map((task) => [task.id, task.name]),
    );
    const { text, entries } = scheduleFailureText(
      this.messages,
      failure,
      (id) => (Object.hasOwn(names, id) ? names[id] : undefined) ?? null,
    );
    const report =
      entries.length === 0 ? null : { title: this.messages.report.scheduleFailed, entries };
    this.#notify('error', text, report);
  }

  /** Tells whether a draft of the details panel works fewer hours a day than the project, so that a daily start time makes sense. */
  worksPartOfDay(draft: TaskDraft): boolean {
    const dayHours = this.calendar?.workingHoursPerDay;
    if (dayHours === undefined) {
      return false;
    }
    const hours = parseDuration(draft.hoursPerDay.trim(), dayHours);
    return hours !== null && hours < dayHours;
  }

  /** Returns a draft of the details panel with one more block of one working day, or the same draft, telling the user why, when the calendar of the project cannot be compiled. */
  withAddedBlock(draft: TaskDraft): TaskDraft {
    const project = this.project;
    const context = project === null ? null : this.#editContext(project);
    if (context === null) {
      this.#notify('error', editErrorMessage(this.messages, 'NOT_POSSIBLE'));
      return draft;
    }
    return withAddedBlock(draft, context.dayHours);
  }

  /** Tells which block of the details panel has a start date that cannot be read or waits for a task or block that does not exist, or null. */
  #blockProblem(draft: TaskDraft): string | null {
    const project = this.project;
    if (project === null || draft.blocks.length < 2) {
      return null;
    }
    const unreadable = findUnreadableBlockStart(draft);
    if (unreadable !== null) {
      return fillMessage(this.messages.details.blockError, {
        number: String(unreadable + 1),
        message: editErrorMessage(this.messages, 'INVALID_DATE'),
      });
    }
    const context = this.#editContext(project);
    if (context === null) {
      return editErrorMessage(this.messages, 'NOT_POSSIBLE');
    }
    const problem = findBlockWaitProblem(context, draft.blocks);
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
      this.#showScheduleFailure(schedule.error, project);
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

  /** Tells the user why a file action failed, with the list of the problems found when there are any, a cancelled action needing no message. */
  #showResult(result: ActionResult<unknown>): void {
    if (result.ok) {
      return;
    }
    const text = fileErrorMessage(this.messages, result.error.code);
    if (text === null) {
      return;
    }
    const issues = 'issues' in result.error ? result.error.issues : [];
    const report =
      issues.length === 0 ? null : this.#issueReport(this.messages.report.fileFailed, issues);
    this.#notify('error', text, report);
  }

  /** Tells the user that the project now starts earlier, so that a task placed before it fits. */
  #notifyStartMove(previousStart: number): void {
    const start = this.project?.startDate;
    if (start !== undefined && start < previousStart) {
      const date = createDayFormatter(this.locale)(start);
      this.#notify('info', fillMessage(this.messages.notices.projectStartMoved, { date }));
    }
  }

  /** Tells the user that changes were adjusted to keep the project valid, with the list of each adjustment and the task it concerns. */
  #notifyRepairs(repairs: readonly SharedRepair[]): void {
    if (repairs.length === 0) {
      return;
    }
    const names: Readonly<Record<string, string>> = Object.fromEntries(
      this.project?.tasks.map((task) => [task.id, task.name]) ?? [],
    );
    const entries = repairs.map((repair) =>
      repairText(
        this.messages,
        repair,
        (id) => (Object.hasOwn(names, id) ? names[id] : undefined) ?? null,
      ),
    );
    this.#notify(
      'warning',
      countMessage(this.messages.notices.repairs, repairs.length, this.locale),
      { title: this.messages.report.repairs, entries },
    );
  }

  /** Builds the detailed list of the problems or warnings of a file, each with its place. */
  #issueReport(title: string, issues: readonly ReportedIssue[]): Report {
    return { title, entries: issues.map((issue) => issueText(this.messages, issue)) };
  }

  /** Shows the failure of an action the user did not start, such as an automatic save. */
  #reportError(error: unknown): void {
    if (error instanceof FileActionError) {
      this.#showResult({ ok: false, error: error.failure });
      return;
    }
    this.#notify('error', this.messages.fileErrors.TASK_FAILED);
    console.error('A file action failed unexpectedly:', error);
  }

  /** Adds a message, replacing the same message already shown so that it is shown once, with its latest details; a message with details, or asked to last, stays until the user dismisses it. */
  #notify(
    kind: NoticeKind,
    text: string,
    report: Report | null = null,
    lasting = report !== null,
  ): void {
    this.#nextNoticeId += 1;
    const others = this.notices.filter((notice) => notice.text !== text);
    this.notices = [...others, { id: this.#nextNoticeId, kind, text, report, lasting }];
  }
}
