# Roadmap

Tasklace is built in nine steps. Each step, or sub-step, is developed on its own branch, tested, reviewed and merged into `main` through a pull request.

| Step | Content                                                    | Status      |
| ---- | ---------------------------------------------------------- | ----------- |
| 1    | Foundations and working-time calendar                      | Done        |
| 2    | Scheduling engine                                          | Done        |
| 3    | Tags and person or team conflicts                          | Done        |
| 4    | Shared model, project file, validation, JSON and CSV       | In progress |
| 5    | Secure Electron shell and Svelte user interface            | Planned     |
| 6    | PDF export and comparison of the page splitting strategies | Planned     |
| 7    | Real-time collaboration on the local network               | Planned     |
| 8    | End-to-end encrypted relay                                 | Planned     |
| 9    | Distribution                                               | Planned     |

## Step 4: shared model, project file, validation, JSON and CSV

Step 4 introduces Yjs. It is split into four sub-steps, each with its own commit and pull request.

### 4a. Project validation and JSON exchange (done)

- Hand-written validator that turns unknown data into a safe `Project`, or returns every problem with its location (for example `tasks[12].segments[0].durationHours`): types and required fields, value ranges, text lengths and valid Unicode, references between objects, calendar, daily working pattern and structure (cycles).
- Readable, versioned JSON export and import, with dates in clear text (`2026-09-28T09:00`).
- A single UTF-8 byte order mark is removed at the very start of imported text; JSON export never writes one.

### 4b. Shared Yjs model and baseline plan

- Two-way mapping between `Project` and the Yjs document (tasks, dependencies, tags, calendar, options), with changes grouped in transactions.
- Task order by hand-written fractional indices, so that two simultaneous insertions at the same place never contradict each other.
- Deterministic repair of merged data that became invalid, run as soon as updates are merged and before anything is saved; running it again changes nothing, and the user is informed:
  - a task pointing at a deleted tag loses its tag;
  - in a dependency cycle, the dependency with the greatest identifier is removed;
  - in a hierarchy loop, the task of the loop with the smallest identifier is moved to the root.
- Baseline plan: a single frozen snapshot per project, stored as one Yjs value with the time it was taken.
- Property-based tests: random concurrent edits and merges always end in the same valid state for every participant.
- An update that arrives before the one it depends on is held back, and an update that would leave an invalid project is refused, the document staying untouched.
- Adds the `yjs` dependency; `y-protocols` comes with the network protocol in step 7.

### 4c. `.tasklace` project file

- Container: `TSKL` signature, format version, flags, CRC-32 checksum, compressed Yjs state, pruned history.
- Compression is injected into the core; the `node:zlib` implementation, with a capped output size, lives in `src/main/`.
- Defensive reading, in this order, before anything is loaded: maximum size, signature, version, checksum, capped decompression against decompression bombs, guarded Yjs decoding, complete validation (4a).
- Maximum file size measured on the largest possible project, then fixed.
- Test files generated in memory from fixed seeds: random, truncated, altered, wrong version, decompression bomb.

### 4d. CSV import and export

- Export of the task table for Excel or LibreOffice: WBS, name, start, end, duration in hours, progress, predecessors, tag. UTF-8 with a byte order mark so that Excel reads accents correctly; separator chosen from the system's regional settings.
- Import of a task list with line-by-line validation; errors give the row and cell. The separator is detected automatically, and a single leading byte order mark is removed.
- Predecessors are imported and exported as `1.2FS+2h`: WBS number, dependency type (FS, SS, FF, SF) and lag.
- Protection against formula injection: a cell starting with `=`, `+`, `-` or `@` is neutralised on export.
