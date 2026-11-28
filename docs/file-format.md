# The Tasklace file format

Tasklace keeps a plan in a `.tasklace` file, and can also export it as JSON. This page describes both, and what stays
true from one version of Tasklace to the next. It is meant for anyone who wants to check what a file holds, read it
without Tasklace, or review how Tasklace opens it.

**Promise:** every file written by any version of Tasklace, from the preview 0.1 on, opens in every later version.

## A `.tasklace` file

A file is a 16-byte header followed by the compressed plan. Numbers are little-endian.

| Offset | Size | Content                                                                         |
| ------ | ---- | ------------------------------------------------------------------------------- |
| 0      | 4    | The signature `TSKL`                                                            |
| 4      | 2    | The version of the file, 1                                                      |
| 6      | 2    | Flags, all 0: a file with any flag set comes from a newer version of Tasklace   |
| 8      | 4    | The CRC-32 of every byte from offset 12 to the end of the file                  |
| 12     | 4    | The size of the plan once decompressed, in bytes                                |
| 16     |      | The plan, compressed with raw DEFLATE (RFC 1951, without a zlib or gzip header) |

Once decompressed, the plan is the state of a [Yjs](https://yjs.dev) document, written as one update (Yjs update format
version 1). Keeping the Yjs state rather than a plain copy of the plan is what lets two copies of a shared plan merge
later. Deleted content is removed from the state; only the marks Yjs needs to merge stay.

A file is at most 128 MiB, and its plan at most 512 MiB once decompressed.

## The document

The Yjs document holds seven maps, and nothing else:

| Map                 | Keys                                                 | Values                          |
| ------------------- | ---------------------------------------------------- | ------------------------------- |
| `project`           | the fields of the plan                               | see below                       |
| `tasks`             | the identifier of a task                             | a map of the fields of the task |
| `dependencies`      | the identifier of a link                             | a map of the fields of the link |
| `tags`              | the identifier of a tag                              | a map of the fields of the tag  |
| `workingWeekdays`   | a weekday, `0` (Sunday) to `6` (Saturday)            | `true`                          |
| `workingTimeRanges` | `start,end` in hours, such as `8,17` or `13.5,17.25` | `true`                          |
| `nonWorkingPeriods` | `firstDay,lastDay` as day numbers                    | `true`                          |

Each task, link and tag is a Yjs map of its fields. Every field, in `project` and in those maps, holds a plain value (a
number, a text, `true` or `false`, `null`, a list or an object), never another Yjs type. The calendar lists are maps
whose keys are their content, so that two people adding a working day at the same time both keep it.

**`project`:**

- `documentId`: the identity of the plan, a lower-case UUID that never changes, even when the file is renamed.
- `formatVersion`: the version of what the document holds, a whole number from 1 (see
  [Versions](#versions-and-compatibility)). The previews 0.1 to 0.4 did not write it: a missing version is 1.
- `name`, `startDate`, `criticalPathEnabled`, `dateConstraintsEnabled`, `baselineEnabled`, `alwaysShowPatterns`.
- `baseline`: `null`, or the frozen plan `{ takenAt, entries }`, each entry being
  `{ taskId, start, end, durationHours }`.

**A task:** `kind` (`task`, `milestone` or `summary`), `name`, `parentId` (`null` at the top), `sortKey` (its place
among its siblings), `progressPercent`, `tagId`, `startNoEarlierThan`, `mustFinishOn`, `deadline`, `segments`,
`hoursPerDay`, `dailyStartHour`. Every task holds every field, whatever its kind, so that a task can change kind and
change back without losing anything; the fields its kind does not use keep their last value. `segments` lists the
blocks of the task, each `{ durationHours, gapDaysBefore, startNoEarlierThan }`, the first one having no gap and no
start date of its own.

**A link:** `predecessorId`, `successorId`, `type` (`finishToStart`, `startToStart`, `finishToFinish` or
`startToFinish`), `lagHours` (negative for a lead), `predecessorBlock` and `successorBlock` (the block a link starts
from or leads to, counted from 0, or `null` for the whole task).

**A tag:** `name`, `color` (`#rrggbb`), `representsPersonOrTeam`.

**Values:**

- An instant is a number of hours since 1 January 1970 at 00:00, counted as a calendar date and time with no time
  zone, from the year 2020 to the year 2200. A day is a number of days since the same date.
- Every instant, duration and lag is a whole number of quarter hours (a multiple of 0.25). Durations and lags count
  working hours of the plan.
- An identifier has 1 to 64 letters, digits, `_` or `-`. A sort key has 1 to 128 letters or digits.

## What Tasklace checks before opening a file

Every file is treated as untrusted, and nothing of it is shown until all of these pass, in this order: the size of the
file, the signature, the version and the flags, the checksum, the declared size (decompression stops there), the Yjs
decoding, the format version (a document of a newer version is refused before anything else in it is looked at), the
exact shape of the document (an unknown map or field, or a format version that is not a whole number from 1, refuses
the whole file), and finally the whole plan: every field, every reference between tasks, links and tags, the calendar,
the hierarchy and the absence of loops between links.

A plan received when joining a shared plan goes through the same checks. A change received while sharing one is
refused when a newer version of Tasklace wrote it, and is otherwise repaired, in the same way on every computer, when it
would break the plan.

## Versions and compatibility

Two numbers say what a file holds:

- **The version in the header** changes only if the container itself changes: the header, the compression or the
  checksum.
- **`formatVersion` in the document** changes when a version of Tasklace changes what the plan holds, such as a new
  field.

The rules that follow from them:

- A newer version of Tasklace reads every older document. Only version 1 exists so far; when a later version needs to
  upgrade an older document, it must do so in the same way on every computer, so that people sharing a plan end up
  with the same plan.
- From version 0.5 on, an older version of Tasklace never opens a newer document or merges a newer change: it says that
  the plan comes from a newer version of Tasklace and asks to update Tasklace. This holds for files, for joining a
  shared plan, for changes received while sharing one, and for a copy of the plan kept on this computer, which is set
  aside unchanged rather than replaced. The previews 0.1 to 0.4 do not know `formatVersion` and refuse such a file as
  damaged.
- The document stays strict: a field or a map Tasklace does not know is refused, never kept or ignored.

The messages of a shared plan and the links of a relay carry their own versions, and from version 0.5 on a person whose
Tasklace differs is told so when joining. On a local network, the previews 0.1 to 0.4 cannot join a plan shared by
version 0.5 or later. Through a relay, they cannot join a plan created by version 0.5 or later, but plans that began in
an older file stay open to them.

## The JSON export

“Export → JSON file…” writes the same plan as compact JSON in UTF-8, without a byte order mark:

```json
{
  "format": "tasklace",
  "version": 2,
  "project": { "name": "…", "startDate": "2026-09-28T09:00", "…": "…" }
}
```

`project` holds `name`, `startDate`, `calendar`, `options`, `tags`, `tasks`, `dependencies` and `baseline`, with the
fields described above and these differences:

- Tasks, links and tags are lists whose items carry their identifier as `id`.
- The four options are grouped in `options`, and the calendar is `{ workingWeekdays, workingTimeRanges,
nonWorkingPeriods }`, with ranges written `{ startHour, endHour }` and periods `{ firstDay, lastDay }`.
- Instants are written `YYYY-MM-DDTHH:MM`, days `YYYY-MM-DD`, and weekdays by their names (`monday`).
- Each task holds only the fields of its kind: a milestone has no `segments`, `hoursPerDay` or `dailyStartHour`, and a
  summary task holds only `id`, `kind`, `name`, `parentId` and `sortKey`.
- The identity of the document is not part of the export: an imported plan is a new plan.

Version 2 writes every field, `null` included, and is read strictly. Version 1, written by the previews 0.1 to 0.4, is
still read: a block without a start date has none, and a link without its blocks links the whole tasks. A version below
1 is refused, and a version above 2 is refused as coming from a newer version of Tasklace.

An imported text is at most 512 Mi UTF-16 code units, and may start with one byte order mark.
