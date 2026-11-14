# Roadmap

_Last updated: 2026-11-14_

This roadmap shows where Tasklace is heading: what is done, what comes next and what may come later. It states intent, not commitments, and gives no dates: Tasklace is a non-commercial project built in the open, and each step is finished only when it is reviewed and fully tested.

## Version 1 at a glance

Version 1 is the first stable release: steps 1 to 10 below and the list in [Before version 1.0](#before-version-10), for Linux first and for Windows. Previews come out before it.

| Step | Content                                              | Status |
| ---- | ---------------------------------------------------- | ------ |
| 1    | Foundations and working-time calendar                | Done   |
| 2    | Scheduling engine                                    | Done   |
| 3    | Tags and person or team conflicts                    | Done   |
| 4    | Shared model, project file, validation, JSON and CSV | Done   |
| 5    | Secure Electron shell and Svelte user interface      | Done   |
| 6    | PDF export                                           | Done   |
| 7    | Real-time collaboration on the local network         | Done   |
| 8    | End-to-end encrypted relay and deployment guide      | Done   |
| 9    | Distribution                                         | Done   |
| 10   | Linux package                                        | Done   |

Once a step is done, only its status is kept here; its pull requests tell the rest. Version 0.2.0 is out as a preview for Linux and Windows, with the Windows files not signed.

## Before version 1.0

- The relay guide also as a PDF, easier to hand to an IT department.
- The `.tasklace` file format made final, so that every file written by version 1 opens in later versions.
- Faster editing of very large plans, where one change currently rebuilds the whole plan.

## Later

- Signed Windows builds, through [SignPath Foundation](https://signpath.org/) if it accepts the project, or another way that keeps the project independent. Until then, Windows releases stay unsigned.
- The relay tried on a public server, with certificates obtained and renewed on their own.
- A macOS version, and more Linux packages, such as `.rpm` for Fedora and openSUSE: the code keeps what is specific to one system in a few small places.
- Languages other than English.
- Custom themes, so that a school or a company can apply its own visual identity. A theme would be a plain data file (colors only, never code or style sheets) dropped into a `themes` folder, and checked like any untrusted file. Official themes must pass WCAG AA contrasts; a custom theme whose contrasts fail would still be accepted with a warning.

## Not planned

These are left out on purpose, to keep Tasklace simple, private and free to run:

- A public relay run by the project: each school or company hosts its own.
- Distribution through an app store: Tasklace is distributed from this repository only.
- Accounts and online storage: plans stay on the computers of the people who share them.
- A web or mobile version.
- Automatic public holidays, resource leveling and costs.
- Several tags on one task, or resource names next to the bars.
- Import from Microsoft Project.

## How the work is done

Each step is developed on its own branch, one sub-step at a time, each merged into that branch through its own reviewed pull request. Interfaces are approved as mockups first. The whole step is then reviewed, corrected and tested again before being merged into `main`.

## Feedback

Suggestions and bug reports are welcome in the [issue tracker](https://github.com/GFayrr/tasklace/issues).
