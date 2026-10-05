import { compileCalendar } from '../../core/calendar/compile-calendar';
import { exportProjectCsv } from '../../core/exchange/csv/project-csv-export';
import { exportProjectJson } from '../../core/exchange/project-json';
import type { Project, TaskId } from '../../core/model/project';
import { success, type Result } from '../../core/result';
import type { MergeFailure, SharedRepair } from '../../core/shared/shared-project';
import type { ValidationIssue } from '../../core/validation/validation-issues';
import type { DailyWindowErrorCode } from '../../core/calendar/task-slots';
import { taskOfCalendarIssue } from '../../core/shared/shared-operations';
import { issueText, repairText, type ReportedIssue } from '../i18n/issue-text';
import { scheduleFailureText } from '../i18n/schedule-failure-text';
import { conflictLines, type ConflictLine } from '../plan/conflict-lines';
import { formatDuration, parseDuration } from '../plan/durations';
import { renameProject, setProjectStart } from '../plan/project-commands';
import { formatTimeOfDay } from '../plan/time-of-day';
import {
  scheduleProject,
  type Schedule,
  type SchedulingFailure,
} from '../../core/scheduling/schedule-project';
import type { SharedSession } from '../../core/shared/shared-session';
import type { TagConflict } from '../../core/tags/tag-conflicts';
import type { ProjectHour } from '../../core/time';
import type { ExchangeKind, RecentProject, TasklaceBridge } from '../../preload/bridge-contract';
import { createDayFormatter } from '../i18n/format';
import {
  countMessage,
  editErrorMessage,
  fileErrorMessage,
  fillMessage,
  type EditRefusal,
  type Messages,
} from '../i18n/messages';
import type { CurrentSchedule, EditableColumn } from '../plan/cell-editing';
import {
  buildPlanOutline,
  NOTHING_COLLAPSED,
  predecessorText,
  toggledSummary,
  withAncestorsOpen,
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
  type ActionFailure,
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

interface ComputedSchedule {
  readonly project: Project;
  readonly schedule: Schedule | null;
}

interface StartMove {
  readonly base: Schedule;
  readonly project: Project | null;
}

const DAILY_WINDOW_CODES: readonly string[] = [
  'INVALID_HOURS_PER_DAY',
  'INVALID_DAILY_START_HOUR',
] satisfies readonly DailyWindowErrorCode[];

/** Tells whether a problem is about the hours a task works each day. */
function isDailyWindowCode(code: string): code is DailyWindowErrorCode {
  return DAILY_WINDOW_CODES.includes(code);
}

/** Returns hours a task must have to be refused for them, failing loudly when it has none. */
function requiredHours(hours: number | null): number {
  if (hours === null) {
    throw new Error('A task refused for its hours of the day has none.');
  }
  return hours;
}

type CloseDecision = 'proceed' | 'discarded' | 'canceled';

export interface EditRequest {
  readonly taskId: TaskId;
  readonly column: EditableColumn;
}

export interface RevealRequest {
  readonly taskId: TaskId;
  readonly hour: ProjectHour;
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
  #project = $state.raw<Project | null>(null);
  #computed = $state.raw<ComputedSchedule | null>(null);
  #scheduleStopped = $state(false);
  #saveStatus = $state<SaveStatus>('saved');
  #hasFile = $state(false);
  #canUndo = $state(false);
  #canRedo = $state(false);
  #recentProjects = $state.raw<readonly RecentProject[]>([]);
  #notices = $state.raw<readonly Notice[]>([]);
  zoom = $state<ZoomLevel>('day');
  selectedTaskId = $state<TaskId | null>(null);
  editRequest = $state<EditRequest | null>(null);
  revealRequest = $state<RevealRequest | null>(null);
  #conflictsOpen = $state(false);
  detailsTaskId = $state<TaskId | null>(null);
  #settingsOpen = $state(false);
  #settingsResets = $state(0);
  #settingsNotice = $state<string | null>(null);
  #settingsAlert = $state<string | null>(null);
  #settingsHeld = false;
  #startMove: StartMove | null = null;
  #closePrompt = $state.raw<ClosePrompt | null>(null);
  #fileActionRunning = $state(false);
  #report = $state.raw<Report | null>(null);
  #lastQuestion: Promise<unknown> = Promise.resolve();
  collapsed = $state.raw<ReadonlySet<TaskId>>(NOTHING_COLLAPSED);
  #openedCount = $state(0);
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
        this.#saveStatus = status;
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
        this.#scheduleStopped = true;
        this.#startMove = null;
        this.#alertSettings(this.messages.notices.scheduleStopped);
        this.#notify('error', this.messages.notices.scheduleStopped, null, true);
      },
    });
  }

  /** Returns the open project, or null. */
  get project(): Project | null {
    return this.#project;
  }

  /** Returns the schedule shown, the latest computed for the open project even when older than its latest change, or null when none is computed or the latest computation failed. */
  get schedule(): Schedule | null {
    return this.#computed?.schedule ?? null;
  }

  /** Describes the conflicts of the schedule shown, with the tags and tasks of the project it was computed for, which may be a little older than the project shown. */
  get conflictLines(): readonly ConflictLine[] {
    const computed = this.#computed;
    return computed === null ? [] : conflictLines(computed.schedule, computed.project);
  }

  /** Returns the schedule computed for the project as it is now, null when that computation failed, or why an edit relying on the dates must wait: the schedule is still being computed after the latest change, or it stopped and needs another change. */
  get currentSchedule(): CurrentSchedule {
    const computed = this.#computed;
    if (computed?.project === this.#project) {
      return { ok: true, value: computed.schedule };
    }
    return { ok: false, error: this.#scheduleStopped ? 'SCHEDULE_STOPPED' : 'SCHEDULE_PENDING' };
  }

  /** Returns the save status of the open project. */
  get saveStatus(): SaveStatus {
    return this.#saveStatus;
  }

  /** Returns whether the open project has a file. */
  get hasFile(): boolean {
    return this.#hasFile;
  }

  /** Returns whether a change can be undone. */
  get canUndo(): boolean {
    return this.#canUndo;
  }

  /** Returns whether an undone change can be redone. */
  get canRedo(): boolean {
    return this.#canRedo;
  }

  /** Returns the recent projects. */
  get recentProjects(): readonly RecentProject[] {
    return this.#recentProjects;
  }

  /** Returns the messages shown to the user. */
  get notices(): readonly Notice[] {
    return this.#notices;
  }

  /** Returns how many projects were opened, so that views start afresh for each. */
  get openedCount(): number {
    return this.#openedCount;
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
        this.#recentProjects = loaded.value;
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
      openSettings: () => {
        this.openSettings();
        return Promise.resolve();
      },
    };
    return actions[command]();
  }

  /** Asks whether to save a changed project that has no file yet before it is closed, telling whether it may be closed. */
  async readyToClose(): Promise<boolean> {
    return (await this.#closeDecision()) !== 'canceled';
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
      return (await this.saveAs()) ? 'proceed' : 'canceled';
    }
    return choice === 'discard' ? 'discarded' : 'canceled';
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
    this.#hasFile = this.#files.hasFile();
    await this.loadRecentProjects();
  }

  /** Asks where to save the project, then saves it there, telling whether it was saved. */
  async saveAs(): Promise<boolean> {
    const saved = await this.#files.saveAs();
    this.#showResult(saved);
    this.#hasFile = this.#files.hasFile();
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
      this.#notify('error', editErrorMessage(this.messages, renamed.error[0].code));
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

  /** Applies a change built from the current project, returning why it was refused, as while a file action runs, or null once applied, telling when the project start moved earlier to make room for a task. */
  tryEdit(
    build: (context: EditContext) => Result<readonly SharedOperation[], EditRefusal>,
  ): string | null {
    const previousStart = this.project?.startDate;
    const refusal = this.#tryExplainedEdit(build, (issue) =>
      editErrorMessage(this.messages, issue.code),
    );
    if (refusal === null && previousStart !== undefined) {
      this.#notifyStartMove(previousStart);
    }
    return refusal;
  }

  /** Tells whether the list of conflicts is shown, which it stops being for good once no conflict is left. */
  get conflictsOpen(): boolean {
    return this.#conflictsOpen;
  }

  /** Shows the list of conflicts, or hides it, showing it only while there are conflicts. */
  toggleConflicts(): void {
    this.#conflictsOpen = !this.#conflictsOpen && this.conflictLines.length > 0;
  }

  /** Selects the first task of a conflict that the project still has, opening the summaries that hide it, and asks the workspace to show the start of the conflict, telling the user to wait when the conflict comes from a schedule older than the deletion of its tasks. */
  showConflict(conflict: TagConflict): void {
    const project = this.project;
    if (project === null) {
      return;
    }
    const taskId = conflict.taskIds.find((id) => project.tasks.some((task) => task.id === id));
    if (taskId === undefined) {
      this.#notify('warning', this.messages.editErrors.SCHEDULE_PENDING);
      return;
    }
    this.collapsed = withAncestorsOpen(this.collapsed, project.tasks, taskId);
    this.selectedTaskId = taskId;
    this.revealRequest = { taskId, hour: conflict.start };
  }

  /** Tells whether the settings of the open project are shown. */
  get settingsOpen(): boolean {
    return this.#settingsOpen;
  }

  /** Counts the times the settings started afresh, on opening or after an undo or redo, so that what they show restarts too. */
  get settingsResets(): number {
    return this.#settingsResets;
  }

  /** Returns the message about the latest move of the project start, telling how many tasks it moved, or null. */
  get settingsNotice(): string | null {
    return this.#settingsNotice;
  }

  /** Returns why the schedule could not be computed after a change made in the settings, or null. */
  get settingsAlert(): string | null {
    return this.#settingsAlert;
  }

  /** Opens the settings of the open project, starting afresh. */
  openSettings(): void {
    if (this.project !== null) {
      this.#resetSettings();
      this.#settingsOpen = true;
    }
  }

  /** Closes the settings of the open project. */
  closeSettings(): void {
    this.#settingsOpen = false;
    this.#resetSettings();
  }

  /** Keeps the settings open at the next attempt to close them, since a value typed in a field was refused as the field was left, perhaps to close them. */
  holdSettingsOpen(): void {
    this.#settingsHeld = true;
  }

  /** Closes the settings unless a refused value holds them open once on its reason, telling whether they closed. */
  closeSettingsUnlessHeld(): boolean {
    if (this.#settingsHeld) {
      this.#settingsHeld = false;
      return false;
    }
    this.closeSettings();
    return true;
  }

  /** Applies a change of the project settings, returning why it was refused, naming the task whose hours per day or daily start no longer fit the working day, or null once applied. */
  editSettings(
    build: (context: EditContext) => Result<readonly SharedOperation[], EditRefusal>,
  ): string | null {
    const refusal = this.#tryExplainedEdit(build, (issue, project) =>
      this.#settingsRefusal(project, issue),
    );
    if (refusal === null) {
      this.#settingsHeld = false;
    }
    return refusal;
  }

  /** Renames the project from its settings, returning why the name was refused or null, an unchanged name changing nothing. */
  renameFromSettings(text: string): string | null {
    const name = text.trim();
    return name === this.project?.name ? null : this.editSettings(() => renameProject(name));
  }

  /** Moves the start of the project, returning why it was refused or null, and tells in the settings how many tasks moved once the schedule of the moved project is known, counting from the schedule before a series of moves when the moves follow each other. */
  moveProjectStart(text: string): string | null {
    const previous = this.#startMove;
    const before = this.currentSchedule;
    const base = previous?.base ?? (before.ok ? before.value : null);
    this.#settingsNotice = null;
    this.#startMove = base === null ? null : { base, project: null };
    const refusal = this.editSettings(() => setProjectStart(text));
    if (refusal !== null) {
      this.#startMove = previous;
    } else if (this.#startMove !== null) {
      this.#startMove = { base: this.#startMove.base, project: this.project };
    }
    return refusal;
  }

  /** Clears what the settings show about earlier changes. */
  #resetSettings(): void {
    this.#settingsNotice = null;
    this.#settingsAlert = null;
    this.#settingsHeld = false;
    this.#startMove = null;
    this.#settingsResets += 1;
  }

  /** Explains why a change of the settings was refused: a task whose hours per day or daily start no longer fit the working day is named, any other problem gets its own text. */
  #settingsRefusal(project: Project, issue: ValidationIssue): string {
    const id = taskOfCalendarIssue(issue);
    const task = project.tasks.find((candidate) => candidate.id === id);
    if (task?.kind !== 'task' || !isDailyWindowCode(issue.code)) {
      return editErrorMessage(this.messages, issue.code);
    }
    const text = this.messages.settings;
    return issue.code === 'INVALID_HOURS_PER_DAY'
      ? fillMessage(text.hoursPerDayTooLong, {
          name: task.name,
          hours: formatDuration(requiredHours(task.hoursPerDay), this.messages, (value) =>
            new Intl.NumberFormat(this.locale).format(value),
          ),
        })
      : fillMessage(text.dailyStartTooLate, {
          name: task.name,
          time: formatTimeOfDay(requiredHours(task.dailyStartHour)),
        });
  }

  /** Applies a change built from the current project, and returns null, or returns why it was refused, a refusal of the shared session being explained from its first problem and the project it was refused for. */
  #tryExplainedEdit(
    build: (context: EditContext) => Result<readonly SharedOperation[], EditRefusal>,
    explain: (issue: ValidationIssue, project: Project) => string,
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
      return explain(applied.error[0], project);
    }
    this.#refresh();
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
    this.#resetSettings();
    this.#showHistoryStep(this.#session?.history.undo(), this.messages.notices.undoFailed);
  }

  /** Redoes the latest undone change, unless a file action runs. */
  redo(): void {
    if (this.#refuseWhileFileActionRuns()) {
      return;
    }
    this.#resetSettings();
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
    this.#notices = this.notices.filter((notice) => notice.id !== id);
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
    this.#computed = null;
    this.selectedTaskId = null;
    this.editRequest = null;
    this.revealRequest = null;
    this.#conflictsOpen = false;
    this.detailsTaskId = null;
    this.closeSettings();
    this.#changedSinceOpened = false;
    this.collapsed = NOTHING_COLLAPSED;
    this.#openedCount += 1;
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
    this.#project = project;
    this.#hasFile = this.#files.hasFile();
    this.#canUndo = session.history.canUndo();
    this.#canRedo = session.history.canRedo();
    this.#scheduleStopped = false;
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
    this.#computed = { project, schedule: result.ok ? result.value : null };
    if (this.conflictLines.length === 0) {
      this.#conflictsOpen = false;
    }
    const move = this.#startMove;
    this.#startMove = null;
    if (!result.ok) {
      this.#showScheduleFailure(result.error, project);
      return;
    }
    this.#settingsAlert = null;
    if (move !== null && (move.project === null || move.project === project)) {
      this.#tellMovedTasks(move.base, result.value);
    }
  }

  /** Tells in the settings how many tasks a move of the project start moved, comparing their starts in the schedule before the move and in the schedule of the moved project. */
  #tellMovedTasks(base: Schedule, schedule: Schedule): void {
    let moved = 0;
    for (const [id, placement] of schedule.placements) {
      if (base.placements.get(id)?.start !== placement.start) {
        moved += 1;
      }
    }
    this.#settingsNotice = countMessage(this.messages.settings.tasksMoved, moved, this.locale);
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
    this.#alertSettings(text);
    this.#notify('error', text, report);
  }

  /** Shows a problem of the schedule inside the open settings, which hide the other messages. */
  #alertSettings(text: string): void {
    if (this.#settingsOpen) {
      this.#settingsAlert = text;
    }
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

  /** Computes the CSV table of a project in the regional format of the system, reusing the schedule already computed for that very project and computing it otherwise. */
  async #csvText(project: Project): Promise<string | null> {
    const computed = this.#computed;
    const known = computed?.project === project ? computed.schedule : null;
    const schedule = known === null ? scheduleProject(project) : success(known);
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

  /** Tells the user why a file action failed, with the list of the problems found when there are any, a canceled action needing no message. */
  #showResult(result: ActionResult<unknown>): void {
    if (result.ok) {
      return;
    }
    const text = fileErrorMessage(this.messages, result.error.code);
    if (text === null) {
      return;
    }
    this.#notify('error', text, this.#failureReport(result.error));
  }

  /** Lists why a file action failed: the problems found in a file, or for a project that could not be saved before another, the failure of that save and its problems, or null when there is nothing more to tell. */
  #failureReport(failure: ActionFailure): Report | null {
    if (failure.code === 'UNSAVED_PROJECT') {
      return failure.cause === null ? null : this.#causeReport(failure.cause);
    }
    const issues = 'issues' in failure ? failure.issues : [];
    return issues.length === 0 ? null : this.#issueReport(this.messages.report.fileFailed, issues);
  }

  /** Lists the failure of the save that kept the open project, then the problems it found. */
  #causeReport(cause: ActionFailure): Report {
    const issues = 'issues' in cause ? cause.issues : [];
    const reason = fileErrorMessage(this.messages, cause.code);
    return {
      title: this.messages.report.saveFailed,
      entries: [
        ...(reason === null ? [] : [reason]),
        ...issues.map((issue) => issueText(this.messages, issue)),
      ],
    };
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
    this.#notices = [...others, { id: this.#nextNoticeId, kind, text, report, lasting }];
  }
}
