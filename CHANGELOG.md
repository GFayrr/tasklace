# Changelog

All notable changes to Tasklace are written down in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until version 1.0.0, a new minor version may change how the application or its files behave.

## [Unreleased]

## [0.1.0] - 2026-11-01

The first public version: a preview for Windows, not signed yet.

### Added

- Planning that follows the rules of the Gantt method: tasks, milestones, summary tasks, the four dependency types with lags and leads, split tasks and working calendars, to the quarter hour.
- A task table and a timeline side by side, with undo and redo, keyboard shortcuts and project settings.
- Tags that color the bars, and the conflicts of a person or a team working on two tasks at once.
- Advanced options, off by default: critical path with floats, date constraints and deadlines, and a baseline.
- `.tasklace` project files, saved automatically with a local copy, and CSV and JSON import and export.
- PDF export with a live preview, on one page or a grid of pages.
- Real-time collaboration on a local network with a short code, or from anywhere through an end-to-end encrypted relay that a school or a company hosts, with a guide to set it up.
- A portable Windows executable and an installer.
- Tasklace settings for this computer, with the version in use and a check for new versions at most once a day, at launch, that can be turned off; Tasklace never updates itself.
- On Windows, `.tasklace` files and Tasklace links open with Tasklace once the person agrees: the installer asks on its own page, before installing, and the first launch asks when no installer did; the uninstaller removes what it set up and keeps the plans, and a link opens the Join window filled in, never joining on its own.

[Unreleased]: https://github.com/GFayrr/tasklace/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/GFayrr/tasklace/releases/tag/v0.1.0
