# Security policy

Tasklace encrypts shared plans, opens files that may come from anyone and ships a relay server meant to be reachable from the Internet. Reports of security problems are taken seriously and are very welcome.

## Supported versions

Only the latest release is supported: security fixes go into a new release, never into older ones. The relay is supported at the same version as the application, as the [relay guide](docs/working-remotely.md#look-after-the-relay) explains.

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately instead, through [GitHub's private vulnerability reporting](https://github.com/GFayrr/tasklace/security/advisories/new). Only the maintainer can read the report.

A useful report says:

- which part is affected: the desktop application, the relay server, the `.tasklace` file format or the deployment guide;
- the commit or version tested, and the operating system;
- the steps to reproduce the problem, with a file or a script when it helps;
- what an attacker could do with it.

Never include a real relay link in a report: the part after `#` holds the keys of a plan. Use a plan made for the test instead.

## What happens next

Tasklace is maintained by one person in their spare time, so there is no guaranteed delay, but every report gets an answer. The problem is confirmed, fixed and tested first; it is then disclosed in a GitHub security advisory, with credit to the reporter unless they prefer otherwise.

## Scope

In scope:

- the desktop application, including the files it opens, the local network sharing and the relay client;
- the relay server in `relay/`, its Docker image and its Docker Compose file;
- the commands and settings given in the [relay guide](docs/working-remotely.md).

Out of scope:

- relays set up differently from the guide, and the security of the servers that host them;
- attacks that need full control of the computer of a member;
- denial of service through sheer volume against a relay, beyond what its quotas are meant to limit.
