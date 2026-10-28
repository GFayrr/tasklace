# Working remotely: setting up a relay

Tasklace lets several people edit the same plan at the same time. On one network, they join each other directly with a short code. When they are in different places, at home, on another site or on the move, they need a **relay**: a small server that passes their changes on. Tasklace has no public relay, so a school or a company runs its own, and this guide explains how.

People only type the address of the relay once, for example `wss://tasklace.my-school.example`. After that, they share a plan by sending a link, and whoever receives the link joins without setting anything up.

## What the relay sees, and what it does not

Every change is encrypted and signed in Tasklace before it leaves the computer. The key is in the link, after the `#`, and never reaches any server.

| The relay never sees                                  | The relay sees                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| The plan: tasks, names, dates, tags                   | An identifier for each plan, derived from its key, that reveals nothing |
| The names of the people in a plan                     | How many people are connected to a plan, and their IP addresses         |
| The links, and so the keys that read or change a plan | The size of the encrypted changes, and when they are sent               |

The relay cannot read a plan, change it, or slip a forged change in: Tasklace refuses any change that the link to edit did not sign. Whoever runs the relay can, at worst, stop passing changes on, and the people in the plan then see that the relay does not answer. The relay keeps no log of IP addresses, and Caddy, the web server in front of it, keeps none of the requests it passes on; only its error messages may name the address of a connection that failed.

Tasklace only reaches a relay over an encrypted connection (`wss://`, as `https://` for a website), on this computer as anywhere else. A relay therefore needs a domain name and a certificate, which Caddy gets and renews on its own in the setup below.

## What you need

- A server that people can reach from wherever they work: a small virtual machine is enough. The relay keeps on disk at most `RELAY_MAX_STORED_BYTES` of plans (1 GiB by default), and in memory only the plans people have open.
- A **domain name** that points at this server, such as `tasklace.my-school.example`.
- The ports **80 and 443 (TCP)** open to the internet. Caddy uses the port 80 to get the certificate and to send plain web requests to the port 443.
- [Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/).

## Set up with Docker Compose

Docker runs the relay and Caddy in two isolated containers. The relay runs as a user without rights, cannot change its own files, keeps its plans in one place (a Docker volume) and is reachable only by Caddy. Caddy alone listens on the ports 80 and 443.

1. Get the files of Tasklace on the server:

   ```sh
   git clone https://github.com/GFayrr/tasklace.git
   cd tasklace/relay
   ```

2. Write the domain name of the server in a file named `.env`, next to `docker-compose.yml`. Every Docker Compose command run from this folder reads it:

   ```sh
   echo "RELAY_DOMAIN=tasklace.my-school.example" > .env
   ```

3. Build and start the relay and Caddy:

   ```sh
   docker compose up -d --build
   ```

4. Check that the relay answers. It replies to a web request with the status `426`, which means it is up and waits for Tasklace:

   ```sh
   curl -I https://tasklace.my-school.example
   ```

   If this fails, `docker compose logs caddy` tells why Caddy could not get the certificate, most often because the domain name does not point at this server yet, or because the port 80 is closed.

5. Give people the address `wss://tasklace.my-school.example`. In Tasklace, they choose **Share**, then **Through a relay**, and type it once.

Both containers start again on their own when the server restarts.

## Settings

The relay reads its limits from environment variables. The defaults suit a school or a company of a few hundred people.

| Variable                                   | Default             | What it limits                                                                                                              |
| ------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_MAX_ROOMS`                          | 4096                | Plans the relay holds at once                                                                                               |
| `RELAY_MAX_ROOM_BYTES`                     | 268435456 (256 MiB) | Encrypted size of one plan with its history                                                                                 |
| `RELAY_MAX_STORED_BYTES`                   | 1073741824 (1 GiB)  | Size of all the plans together                                                                                              |
| `RELAY_MAX_CONNECTIONS`                    | 1024                | People connected at once                                                                                                    |
| `RELAY_MAX_CONNECTIONS_PER_ADDRESS`        | 32                  | People connected at once from one IP address                                                                                |
| `RELAY_CONNECTIONS_PER_MINUTE_PER_ADDRESS` | 64                  | New connections per minute from one IP address                                                                              |
| `RELAY_ROOM_EXPIRY_DAYS`                   | 90                  | Days after which a plan nobody opened is removed                                                                            |
| `RELAY_TRUST_PROXY`                        | `0`                 | `1` when a proxy in front of the relay gives the address of each person: set by the Compose file, since Caddy is that proxy |

A plan also takes at most 64 people at once. When many people work from one site behind a single public IP address, raise the two limits per address. To change a setting, create a file named `docker-compose.override.yml` next to `docker-compose.yml`, which Docker Compose reads on its own and which updates never touch:

```yaml
services:
  relay:
    environment:
      RELAY_MAX_CONNECTIONS_PER_ADDRESS: '256'
      RELAY_CONNECTIONS_PER_MINUTE_PER_ADDRESS: '512'
```

Then run `docker compose up -d` again. A wrong value stops the relay, which Docker Compose reports as `unhealthy`; `docker compose logs relay` then names the setting and the values it takes.

## Look after the relay

- **Updates.** Each version of Tasklace fixes the exact versions of the images it uses. To update, get the new files and build again:

  ```sh
  git pull
  docker compose up -d --build
  docker image prune
  ```

  People who are connected see the relay come back on its own; their changes are kept meanwhile.

- **Backups** are optional. Every person in a plan keeps a full copy of it on their own computer, so if the relay loses its plans, the owner of each plan shares it again and sends the new links. To keep a copy of the encrypted plans anyway:

  ```sh
  docker compose cp relay:/data ./relay-backup-$(date +%F)
  ```

- **Removing a plan.** The relay cannot tell which plan is which, by design. Someone with the link to edit a plan empties its place on the relay with **Make new links** in Tasklace. A plan nobody opens is removed after `RELAY_ROOM_EXPIRY_DAYS` days.

- **Stopping the relay** keeps its plans: `docker compose down`. To remove the plans as well: `docker compose down --volumes`.

## Try it on a single computer

To see the relay work before setting up a server, run it with Docker on your own computer, under the name `localhost`. Caddy then makes its own certificate, which you tell only one start of Tasklace to trust:

```sh
cd tasklace/relay
echo "RELAY_DOMAIN=localhost" > .env
docker compose up -d --build
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Start Tasklace from a terminal where the environment variable `NODE_EXTRA_CA_CERTS` holds the full path of `caddy-root.crt`, and share through `wss://localhost`. Started otherwise, Tasklace refuses this relay, as it would refuse any relay whose certificate is not valid. When you are done, remove everything with `docker compose down --volumes`.

## Troubleshooting

| Tasklace says                                             | What it means                                                                       | What to do                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The relay … did not answer                                | Tasklace cannot reach the server                                                    | Check the address, the domain name, the ports 80 and 443, and `docker compose ps` |
| The relay … could not prove who it is                     | The certificate is missing, out of date, or for another name                        | Check `docker compose logs caddy` and that the address typed is the domain name   |
| A relay must be reached with wss://                       | The address typed starts with `ws://`, `https://` or nothing                        | Give the address starting with `wss://`                                           |
| Too many connections come from your network               | `RELAY_MAX_CONNECTIONS_PER_ADDRESS` or the limit per minute is reached              | Raise both limits for a site behind a single IP address                           |
| The relay … takes no more plans for now                   | `RELAY_MAX_ROOMS` or `RELAY_MAX_STORED_BYTES` is reached, or the disk is full       | Raise the limits, or free disk space                                              |
| The relay keeps no more for this plan                     | The plan reached `RELAY_MAX_ROOM_BYTES`                                             | Raise the limit; the changes stay on each computer meanwhile                      |
| This plan already has as many people as the relay … takes | The plan has 64 people connected                                                    | Wait for someone to leave                                                         |
| This plan is no longer on the relay                       | The plan was given new links, or nobody opened it for `RELAY_ROOM_EXPIRY_DAYS` days | Ask the owner of the plan for the new links                                       |
| The relay … uses another version of Tasklace              | The relay and the application are of different versions                             | Update the relay and Tasklace to the same version                                 |
