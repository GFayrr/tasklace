# Roadmap

Tasklace is built in nine steps. Each step, or sub-step, is developed on its own branch, tested, reviewed and merged into `main` through a pull request.

| Step | Content                                                    | Status  |
| ---- | ---------------------------------------------------------- | ------- |
| 1    | Foundations and working-time calendar                      | Done    |
| 2    | Scheduling engine                                          | Done    |
| 3    | Tags and person or team conflicts                          | Done    |
| 4    | Shared model, project file, validation, JSON and CSV       | Done    |
| 5    | Secure Electron shell and Svelte user interface            | Planned |
| 6    | PDF export and comparison of the page splitting strategies | Planned |
| 7    | Real-time collaboration on the local network               | Planned |
| 8    | End-to-end encrypted relay                                 | Planned |
| 9    | Distribution                                               | Planned |

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
- Compression is injected into the core; the real `node:zlib` implementation, with a capped output size, will live in `src/main/` (step 5).
- Defensive reading, in this order, before anything is loaded: maximum size, signature, version, flags, checksum, declared size, capped decompression against decompression bombs, guarded Yjs decoding, strict schema and complete validation (4a), without any repair.
- Maximum sizes measured on the largest possible project, then fixed as powers of two above it: 128 MiB for a file, 512 MiB once decompressed.
- Opening a file will run in a separate process with capped memory, so that a forged file can never bring the application down.
- Fast compression (zlib level 1): the file is slightly larger, but saving, which happens automatically, is much faster.
- JSON export is compact, so that the largest possible project stays within the 256 Mi-unit import limit.
- Test files generated in memory: random, truncated, altered, wrong version or flags, lying declared size, decompression bomb, hidden content.

### 4d. CSV import and export (done)

- Export of the task table for Excel or LibreOffice, in WBS order: WBS, name, start, end, duration in hours, progress, predecessors, tag and blocks (filled only for split tasks, such as `4h; +2d 3h`). UTF-8 with a byte order mark so that Excel reads accents correctly; separator, date order and clock taken from the regional settings.
- Import creates a new project with the default calendar, starting at the earliest start of the table. Only the name column is required; columns may come in any order, and a row holding only a name is a section heading.
- A start date becomes a "not before" constraint only where the schedule would otherwise start the task earlier; end dates are recomputed, and each start, end or summary progress the schedule does not follow gets its own warning.
- Unknown tags are created with the next palette color. Dates are read in the regional date order or in ISO form. A duration or progress column counted in another unit (days, minutes…) is refused rather than misread.
- Line-by-line validation with the same complete checks as JSON; each error gives its row, and its column when a single cell is at fault. Limits on rows, predecessors and blocks are checked before anything is built, so that an oversized file is refused without exhausting memory. The separator is detected automatically, and a single leading byte order mark is removed.
- Predecessors are imported and exported as `1.2FS+2h`: WBS number, dependency type (FS, SS, FF, SF) and lag.
- Protection against formula injection: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an apostrophe on export, which the import removes.
- Import limited to 128 Mi UTF-16 units, above the export of the largest allowed project.
