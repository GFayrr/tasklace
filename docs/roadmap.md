# Roadmap

Tasklace is built in nine steps.

| Step | Content                                              | Status  |
| ---- | ---------------------------------------------------- | ------- |
| 1    | Foundations and working-time calendar                | Done    |
| 2    | Scheduling engine                                    | Done    |
| 3    | Tags and person or team conflicts                    | Done    |
| 4    | Shared model, project file, validation, JSON and CSV | Done    |
| 5    | Secure Electron shell and Svelte user interface      | Done    |
| 6    | PDF export                                           | Done    |
| 7    | Real-time collaboration on the local network         | Planned |
| 8    | End-to-end encrypted relay                           | Planned |
| 9    | Distribution                                         | Planned |

Each step is developed on its own branch, one sub-step at a time, each merged into that branch through its own reviewed pull request; interfaces are approved as mockups first, and the whole step is reviewed and corrected before being merged into `main`. Once a step is done, only its status is kept here; the history of its pull requests tells the rest.

## After version 1

- Custom themes, to be considered only once the project is finished: a documented theme template so that a school or a company can apply its own visual identity. A theme is a plain data file (colors only, never code or style sheets) dropped into a `themes` folder easy to open from the application, and validated like any untrusted file. Official themes must pass WCAG AA contrasts; a custom theme whose contrasts fail is still accepted with a warning, its authors remaining responsible for their colors.
