# Roadmap

_Last updated: 2026-10-31_

This roadmap shows where Tasklace is heading: what is done, what comes next and what may come later. It states intent, not commitments, and gives no dates: Tasklace is a non-commercial project built in the open, and each step is finished only when it is reviewed and fully tested.

## Version 1 at a glance

Version 1 is the first release that people can download and use: steps 1 to 9 below, for Windows first.

| Step | Content                                              | Status      |
| ---- | ---------------------------------------------------- | ----------- |
| 1    | Foundations and working-time calendar                | Done        |
| 2    | Scheduling engine                                    | Done        |
| 3    | Tags and person or team conflicts                    | Done        |
| 4    | Shared model, project file, validation, JSON and CSV | Done        |
| 5    | Secure Electron shell and Svelte user interface      | Done        |
| 6    | PDF export                                           | Done        |
| 7    | Real-time collaboration on the local network         | Done        |
| 8    | End-to-end encrypted relay and deployment guide      | Done        |
| 9    | Distribution                                         | In progress |

Once a step is done, only its status is kept here; its pull requests tell the rest.

## In progress: distribution (step 9)

- A portable Windows executable, signed, that runs with a double-click and nothing else to install.
- An installer for those who prefer one.
- `.tasklace` files and `tasklace://` invitation links that open in Tasklace, set up for the current user without administrator rights.
- A check for new versions on GitHub Releases that can be turned off. There will be no automatic update: Tasklace only offers to open the release page.
- Signed builds made by continuous integration on Windows.

## Before version 1.0

- The relay guide also as a PDF, easier to hand to an IT department.
- The `.tasklace` file format made final, so that every file written by version 1 opens in later versions.
- Faster editing of very large plans, where one change currently rebuilds the whole plan.
- The relay tried on a public server, with certificates obtained and renewed on their own.

## Later

- macOS and Linux versions: the code already avoids anything specific to Windows outside one folder.
- Languages other than English.
- Custom themes, so that a school or a company can apply its own visual identity. A theme would be a plain data file (colors only, never code or style sheets) dropped into a `themes` folder, and checked like any untrusted file. Official themes must pass WCAG AA contrasts; a custom theme whose contrasts fail would still be accepted with a warning.

## Not planned

These are left out on purpose, to keep Tasklace simple, private and free to run:

- A public relay run by the project: each school or company hosts its own.
- Accounts and online storage: plans stay on the computers of the people who share them.
- A web or mobile version.
- Automatic public holidays, resource leveling and costs.
- Several tags on one task, or resource names next to the bars.
- Import from Microsoft Project.

## How the work is done

Each step is developed on its own branch, one sub-step at a time, each merged into that branch through its own reviewed pull request. Interfaces are approved as mockups first. The whole step is then reviewed, corrected and tested again before being merged into `main`.

## Feedback

Suggestions and bug reports are welcome in the [issue tracker](https://github.com/GFayrr/tasklace/issues).
