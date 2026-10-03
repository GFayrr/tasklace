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

## Step 4: shared model, project file, validation, JSON and CSV

Step 4 introduces Yjs. It is split into four sub-steps, each with its own commit and pull request.

### 4a. Project validation and JSON exchange (done)

- Hand-written validator that turns unknown data into a safe `Project`, or returns every problem with its location (for example `tasks[12].segments[0].durationHours`): types and required fields, value ranges, text lengths and valid Unicode, references between objects, calendar, daily working pattern and structure (cycles).
- Versioned JSON export and import, with dates in clear text (`2026-09-28T09:00`); the export is compact since 4c.
- A single UTF-8 byte order mark is removed at the very start of imported text; JSON export never writes one.

### 4b. Shared Yjs model and baseline plan (done)

- Two-way mapping between `Project` and the Yjs document (name, start date, calendar, options, baseline, tasks, dependencies, tags), with changes grouped in transactions.
- Task order by hand-written fractional indices, so that two simultaneous insertions at the same place never contradict each other.
- Deterministic repair of merged data that became invalid, run as soon as updates are merged and before anything is saved; running it again changes nothing, and the user is informed. For example:
  - a task pointing at a deleted tag loses its tag;
  - in a dependency cycle, the dependency with the greatest identifier is removed;
  - in a hierarchy loop, the task of the loop with the smallest identifier is moved to the root.
- Baseline plan: a single frozen snapshot per project, stored as one Yjs value with the time it was taken.
- Property-based tests: random concurrent edits and merges always end in the same valid state for every participant.
- Every received update is first tried on a copy: an update that arrives before the one it depends on is held back, and an update that is unreadable, breaks the document schema or would leave an invalid project is refused, the document staying untouched.
- Adds the `yjs` dependency; `y-protocols` comes with the network protocol in step 7.
- A shared session keeps a validated, indexed copy of the project: local edits and received updates are checked and repaired only where they change things, falling back to the whole repair when a structural rule is broken, so that editing and merging stay far below one frame on 10,000 tasks.

### 4c. `.tasklace` project file (done)

- Container: 16-byte header (`TSKL` signature, format version, reserved flags, CRC-32 checksum, declared uncompressed size), then the compressed Yjs state, whose deleted content Yjs has already removed.
- Compression is injected into the core; the real `node:zlib` implementation, with a capped output size, lives in `src/main/` (done in 5b).
- Defensive reading, in this order, before anything is loaded: maximum size, signature, version, flags, checksum, declared size, capped decompression against decompression bombs, guarded Yjs decoding, strict schema and complete validation (4a), without any repair.
- Maximum sizes measured on the largest possible project, then fixed as powers of two above it: 128 MiB for a file, 512 MiB once decompressed.
- Opening a file runs in a separate process with capped memory, so that a forged file can never bring the application down (done in 5b).
- Fast compression (zlib level 1): the file is slightly larger, but saving, which happens automatically, is much faster.
- JSON export is compact, so that the largest possible project stays within the import limit (512 Mi UTF-16 units since block start dates were added).
- Test files generated in memory: random, truncated, altered, wrong version or flags, lying declared size, decompression bomb, hidden content.

### 4d. CSV import and export (done)

- Export of the task table for Excel or LibreOffice, in WBS order: WBS, name, start, end, duration in hours, progress, predecessors, tag and blocks (filled only for split tasks, such as `4h; +2d 3h`). UTF-8 with a byte order mark so that Excel reads accents correctly; separator, date order and clock taken from the regional settings.
- Import creates a new project with the default calendar, starting at the earliest start of the table. Only the name column is required; columns may come in any order, and a row holding only a name is a section heading.
- A start date becomes a "not before" constraint only where the schedule would otherwise start the task earlier; end dates are recomputed, and each start, end or summary progress the schedule does not follow gets its own warning.
- Unknown tags are created with the next palette color. Dates are read in the regional date order or in ISO form. A duration or progress column counted in another unit (days, minutes…) is refused rather than misread.
- Line-by-line validation with the same complete checks as JSON; each error gives its row, and its column when a single cell is at fault. Limits on rows, predecessors and blocks are checked before anything is built, so that an oversized file is refused without exhausting memory. The separator is detected automatically, and a single leading byte order mark is removed.
- Predecessors are imported and exported as `1.2FS+2h`: WBS number, dependency type (FS, SS, FF, SF) and lag.
- Protection against formula injection: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an apostrophe on export, which the import removes.
- Import limited to 256 Mi UTF-16 units, above the export of the largest allowed project (raised from 128 Mi when block start dates were added).
- Faster import and export (step 4 follow-up): one scheduling pass per import, keeping only the start dates the schedule needs; dates parsed and formatted once each; blank lines and unknown columns skipped without building their cells.

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
- Sober light theme "Sand & Graphite" (warm neutrals, graphite actions, so that the task bars carry the colour): every colour is a style variable, ready for custom themes, and a test checks the WCAG AA contrasts. Jost font embedded with its licence (Latin and Latin Extended).
- Translation structure: typed keys in `en.json`, loaded on demand; a test refuses any visible text written directly in a component. Dates and numbers follow the regional format.
- Scheduling in a Web Worker, one computation at a time, the latest change only, so that no older result is ever shown.
- Undo and redo local to each user, never undoing the changes of others; an undone step made invalid by them is repaired like a received update.
- Welcome screen with the recent projects, toolbar (new, open, import, export as CSV or JSON, save, undo, redo, editable project name, save status), tag legend with the task count and dates of the project, messages that explain errors without blocking anything; keyboard shortcuts.

### 5d. Task table and timeline (done)

- Task table in WBS order (WBS, name, duration, start, end, progress, predecessors), drawing only the visible rows, with the WBS and name columns kept in view; summaries can be collapsed.
- Canvas timeline: two-level time scale, hour, day, week and month zooms keeping the middle instant, shaded non-working periods, today line, split blocks, progress, milestone diamonds, summary bars, dependency arrows, tag colours and patterns, conflict outlines.
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

### 5e. Project settings and advanced options

- Project name and start date, working calendar editor, tag management.
- Advanced options, disabled by default: critical path, date constraints, baseline plan with ghost bars, always showing patterns.
- List of tag conflicts.

## After version 1

- Custom themes: a documented theme template, so that a school or a company can apply its own visual identity to the application. To be considered only once the project is finished.
  - A `themes` folder, easy to open from the application, where a theme file is simply dropped.
  - A theme is a plain data file (colours only, never code or style sheets), validated like any untrusted file.
  - Official themes must pass WCAG AA contrasts. A custom theme whose contrasts fail is still accepted, with a warning: its authors remain responsible for their colours.
