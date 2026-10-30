# Contributing to Tasklace

Thank you for your interest in Tasklace. The project is at an early stage and is not accepting pull requests yet: its design is still settling step by step, as the [roadmap](docs/roadmap.md) shows. Bug reports and suggestions are very welcome, and they shape what comes next.

## Reporting a bug

Open a [bug report](https://github.com/GFayrr/tasklace/issues/new/choose) and fill in the form. The most useful reports say what you did, what you expected and what happened instead, with the commit or version and the operating system.

Tasklace writes its errors to a log file: on Windows, `%APPDATA%\Tasklace\logs\tasklace.log`. Adding the lines from around the problem helps a lot. Read them first: they may name your files or plans.

Never paste a relay link: the part after `#` holds the keys of a plan.

## Suggesting a feature

Open a [suggestion](https://github.com/GFayrr/tasklace/issues/new/choose) and describe the need before the solution: what you are trying to do, and why it is hard today. Some features are left out on purpose; the [roadmap](docs/roadmap.md#not-planned) lists them.

## Reporting a security problem

Do not open an issue. Follow the [security policy](SECURITY.md) instead.

## Running Tasklace from the source code

You need [Node.js](https://nodejs.org/) 24 LTS and npm.

```sh
git clone https://github.com/GFayrr/tasklace.git
cd tasklace
npm install
npm run dev
```

The [README](README.md#development) lists every command. Before sharing a change, these must pass:

```sh
npm run lint
npm run format:check
npm test
```

## Conventions

- Code, comments, interface texts and commit messages are in English.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- Every function has a one-sentence comment, and every file keeps at least 90% test coverage.
- Any new dependency is discussed first: the project prefers the standard library.

## License

Tasklace is licensed under the [AGPL-3.0-or-later](LICENSE). Any contribution is made under the same license, without a contributor license agreement.
