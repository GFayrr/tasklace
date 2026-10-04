# Roadmap

Tasklace is built in nine steps. Each step, or sub-step, is developed on its own branch, tested, reviewed and merged into `main` through a pull request.

| Step | Content                                                    | Status      |
| ---- | ---------------------------------------------------------- | ----------- |
| 1    | Foundations and working-time calendar                      | Done        |
| 2    | Scheduling engine                                          | Done        |
| 3    | Tags and person or team conflicts                          | Done        |
| 4    | Shared model, project file, validation, JSON and CSV       | Done        |
| 5    | Secure Electron shell and Svelte user interface            | In progress |
| 6    | PDF export and comparison of the page splitting strategies | Planned     |
| 7    | Real-time collaboration on the local network               | Planned     |
| 8    | End-to-end encrypted relay                                 | Planned     |
| 9    | Distribution                                               | Planned     |

## Step 5: secure Electron shell and Svelte user interface

Step 5 turns the core into a desktop application. It is developed on a single branch, one sub-step after the other, each ending with its own commit. The sub-steps that do not shape the look of the application come first.

### 5a. Tooling and secure shell (done)

- Electron, electron-vite and Playwright; development, build and end-to-end test commands.
- Main process: a single window with context isolation, sandbox, no Node.js in the page and web security; a strict content security policy; no remote content; navigation, new windows and permission requests refused; a single running instance; external links opened only for an allowlist of `https` addresses.
- Preload bridge: a minimal, typed API exposed with `contextBridge`; every channel is listed and every message is validated by the main process with hand-written validators.
- Lint rules keep the page away from Node.js and Electron, and the core pure.
- End-to-end tests check the security settings in the running application; continuous integration runs them on Linux and Windows.

### 5b. Files and isolated decoding (done)

- The real zlib compressor, with a capped output size, in the main process; file sizes checked in bytes before reading.
- Opening a `.tasklace` file and importing JSON or CSV run in a worker thread whose memory is capped, so that a forged file can only stop that worker; the application then shows a clear error.
- The shared project stays in the page; the main process alone chooses paths through dialogs, and knows the file and the document of each window.
- Automatic saving two seconds after the last change and before a window closes, written to a temporary file then renamed. A project without a file yet is kept in its local copy only, so that saving automatically never opens a dialog.
- Every document has a stable, hidden identifier; its local copy, kept for offline work and future collaboration, is written at each save with an index of where its file lives.
- The three most recent projects; open, save, save as, import and export dialogs.
- The regional format of the system (list separator, date order, clock) is read by the main process for CSV exchange; every file error has an English message in the translation file.

### 5c. Interface foundations (done)

- Svelte 5 interface, with its compiler, type checker, formatter and linter; no inline style or script, so the strict content security policy is kept.
- Sober light theme "Sand & Graphite" (warm neutrals, graphite actions, so that the task bars carry the color): every color is a style variable, ready for custom themes, and a test checks the WCAG AA contrasts. Jost font embedded with its license (Latin and Latin Extended).
- Translation structure: typed keys in `en.json`, loaded on demand; a test refuses any visible text written directly in a component. Dates and numbers follow the regional format.
- Scheduling in a Web Worker, one computation at a time, the latest change only, so that no older result is ever shown.
- Undo and redo local to each user, never undoing the changes of others; an undone step made invalid by them is repaired like a received update.
- Welcome screen with the recent projects, toolbar (new, open, import, export as CSV or JSON, save, undo, redo, editable project name, save status), tag legend with the task count and dates of the project, messages that explain errors without blocking anything; keyboard shortcuts.

### 5d. Task table and timeline (done)

- Task table in WBS order (WBS, name, duration, start, end, progress, predecessors), drawing only the visible rows, with the WBS and name columns kept in view; summaries can be collapsed.
- Canvas timeline: two-level time scale, hour, day, week and month zooms keeping the middle instant, shaded non-working periods, today line, split blocks, progress, milestone diamonds, summary bars, dependency arrows, tag colors and patterns, conflict outlines.
- Editing from the toolbar, the keyboard and the table: add, delete, rename, indent (Alt+Shift+→) and outdent (Alt+Shift+←), reorder (Alt+↑ and Alt+↓), turn into a milestone, type a duration in hours or working days, a start date, a progress or predecessors in the notation of the CSV table.
- On the timeline: move a bar to set its start date, stretch its end to change its duration, drag from the handle of the selected bar to another bar to link them; bars align to the quarter hour at the hour zoom, to the day otherwise.
- Every change is checked by the shared session as one step, undone in one step, and explained when refused; the zoom sits in the status bar.
- 60 frames per second while scrolling 10,000 tasks; a change refreshes what the interface shows within a frame.

### 5d, after testing: quarter hours, date picker, tags and task details (done)

- Quarter-hour precision everywhere: durations shown in hours and minutes, typed in hours, minutes or working days; a task may last less than an hour.
- Date and time picker built into the application for the start and end of a task; the end can be typed too.
- A task placed before the project start moves that start, with a message that can be undone.
- Tag column with a list of its own, and a task details panel (tag, blocks, hours per day, daily start time).
- Messages fade away on their own; days off show as a thin pale band inside bars, the pause of a split task as a dotted line; the default menu of Electron is removed.

### 5d, after testing: split tasks linked block by block (done)

- A block of a split task can wait for another task or for a block of it, and a task can wait for a block, with the same link types and lags; the days before a block become a minimum, 0 meaning the same day.
- Scheduling, critical path and collaborative repairs reason block by block, at the same cost.
- Notation `3#2` (block 2 of task 3) in the predecessors, and `+0d 3h after 2.1` in the Blocks column of the CSV table.
- "Block n waits for" in the task details; one link handle per block on the timeline, and a link dropped on a block makes that block wait.
- After review: a link is always written in its shortest form; no link is ever lost silently (exports and edits that would lose one are refused with an explanation); the details panel refuses to overwrite a task changed meanwhile; changing the blocks of a much-linked task stays linear.

### 5d, after testing: block start dates and file names (done)

- A later block of a split task can be given its own "do not start before" date and time, in the task details or by dragging it alone on the timeline; the blocks after it follow.
- Saving and exporting add the missing extension, suggest the name of the project, and ask before replacing a file the added extension leads to; an export can never overwrite a project file.
- Imports and exports say what they did; an untitled imported project takes the name of its file.
- Failed application tests keep a trace, and a window that does not close is described instead of blocking the test run.
- A window closed while its interface is still starting now closes at once (it used to stay open forever).
- Moving a whole task moves the dates of its later blocks with it.

### 5d, after the project review: file safety and full test coverage (done)

- One file action at a time: opening, importing, creating, saving or exporting while another runs is refused with a message, and the open project is saved before another replaces it (or kept open when that save fails); automatic and manual saves are sent one after the other.
- The main process switches to a new, opened or imported project only once the interface has accepted it, so that both always agree on the project of the window.
- A window whose last save fails stays open and offers to save elsewhere, close without saving or cancel; a page that crashes or cannot start offers to reload or close the window, and a page that stops responding while closing offers to wait or close anyway.
- Every failure the main process meets while handling a file is reported, and unexpected errors of the interface are shown; failed imports, import warnings and repairs list each problem with its row, column or task.
- Errors and warnings of the application, of its pages and of its file worker are written to a log file in the user data folder, kept under 1 MiB.
- Files are read through a single handle with a bounded size; the state is checked before writing; a file saved without its local copy is kept, with a warning; a damaged local copy index is kept aside.
- A schedule worker that fails is replaced and asked again for the latest project; a failure that repeats leaves a lasting message.
- The table writes and reads dates only as ISO (2026-10-05 14:30); CSV keeps the regional format.
- Recent projects are listed once per path, with their folder; summaries fold and unfold with Alt+Left / Alt+Right.
- Every file of `src/` except the entry points and workers, which the end-to-end tests cover, is unit tested to at least 90 % of its lines, branches, functions and statements, Svelte components included; new property tests (date constraints turned off, weighted progress, tag conflicts, order of the data); new end-to-end journeys (automatic save, keyboard outline, dragging a block, crashed page, shortcuts during a dialog, unexpected errors) and an opening benchmark (under 2 s for 10,000 tasks).

### 5d, after the full analysis: blocked file actions, explained failures and stricter types (done)

- While a file is opened, imported, created, saved or exported, the whole window waits: no change, shortcut or other file action can slip in and be lost.
- A schedule that cannot be computed says why, cause by cause, with the task, link or tag concerned.
- Failures that used to pass unnoticed are reported or logged: a repair that fails while merging or undoing, an unreadable list of recent projects, a schedule worker that cannot start, a log that cannot be set aside, unexpected answers between the processes.
- A change is refused rather than applied on guessed values: a calendar that cannot be compiled, or a bar dragged while the dates are still being updated after the last change.
- Types now tie each channel of the bridge to its answer, each file task to its result and each refusal to its message, so that a mismatch no longer compiles.
- Tests cover the session as the entry point of the network, the baseline plan in random projects, and every branch that only random tests reached before.

### 5e. Project settings and advanced options

- Project name and start date, working calendar editor, tag management.
- Advanced options, disabled by default: critical path, date constraints, baseline plan with ghost bars, always showing patterns.
- List of tag conflicts.

## After version 1

- Custom themes: a documented theme template, so that a school or a company can apply its own visual identity to the application. To be considered only once the project is finished.
  - A `themes` folder, easy to open from the application, where a theme file is simply dropped.
  - A theme is a plain data file (colors only, never code or style sheets), validated like any untrusted file.
  - Official themes must pass WCAG AA contrasts. A custom theme whose contrasts fail is still accepted, with a warning: its authors remain responsible for their colors.
