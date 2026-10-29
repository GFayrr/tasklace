# Working remotely: setting up a relay

Tasklace lets several people edit the same plan at the same time. On one network, they join each other directly with a short code. When they are in different places, at home, on another site or on the move, they need a **relay**: a small server that passes their changes on. Tasklace has no public relay, so a school or a company runs its own, and this guide explains how.

People only type the address of the relay once, for example `wss://tasklace.my-school.example`. After that, they share a plan by sending a link, and whoever receives the link joins without setting anything up.

## What the relay sees, and what it does not

Every change is encrypted and signed in Tasklace before it leaves the computer. The key is in the link, after the `#`, and never reaches any server.

| The relay never sees                                  | The relay sees                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The plan: tasks, names, dates, tags                   | An identifier for each plan, derived from its key, that reveals nothing                |
| The names of the people in a plan                     | How many people are connected to a plan, and their IP addresses                        |
| The links, and so the keys that read or change a plan | The size of the encrypted changes, and when they are sent                              |
|                                                       | The key that checks the signatures of a plan, which can neither read nor sign a change |

The relay cannot read a plan, change it, or slip a forged change in: Tasklace refuses any change that the link to edit did not sign. Whoever runs the relay can, at worst, stop passing changes on, and the people in the plan then see that the relay does not answer. The relay keeps no log of IP addresses of its own. With Docker, Caddy, the web server in front of it, keeps none of the requests it passes on either; only its error messages may name the address of a connection that failed. Apache and nginx do write the address of each connection in their access logs, unless told not to, as shown below, and their error logs may name the address of a connection that failed.

Anyone who knows the address of the relay can share plans through it, within the limits set in [Settings](#settings). To keep it for your own people, let only your network or your VPN reach it, with the firewall of the server or of your network. With Docker, use the firewall of your network: Docker opens the ports 80 and 443 itself, past a firewall of the server such as `ufw`.

Tasklace only reaches a relay over an encrypted connection (`wss://`, as `https://` for a website), on this computer as anywhere else. A relay therefore needs a domain name and a certificate: with Docker, Caddy gets and renews it on its own; without Docker, the relay uses the certificate of the server, from Let's Encrypt for example.

## What you need

- A server that people can reach from wherever they work: a small virtual machine is enough. The relay keeps on disk at most `RELAY_MAX_STORED_BYTES` of plans (1 GiB by default), and in memory only the plans people have open. A person on a slow connection may also have up to two plans of `RELAY_MAX_ROOM_BYTES` waiting in memory before the relay cuts them off, so raising this limit raises the memory the relay may need.
- A **domain name** that points at this server, such as `tasklace.my-school.example`.
- The ports **80 and 443 (TCP)** open to the internet. The relay itself only needs the port 443; the port 80 serves to get and renew the certificate and, with Docker, Apache or nginx, to send plain web requests on to the port 443.
- Either [Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/), the simplest, or [Node.js 24](https://nodejs.org/en/download) with a certificate for the domain, alone or behind Apache (2.4.47 or later) or nginx.

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

## Set up without Docker

On a server that already runs Apache or nginx, or that should run nothing else than the relay, `systemd` can run the relay itself. The commands below are for Debian and Ubuntu, and `tasklace.my-school.example` stands for the domain of the server.

1. Install [Node.js 24](https://nodejs.org/en/download), then get the files of Tasklace and the one package the relay needs:

   ```sh
   sudo git clone https://github.com/GFayrr/tasklace.git /opt/tasklace
   cd /opt/tasklace/relay
   sudo npm ci --omit=dev --ignore-scripts
   ```

2. Get a certificate for the domain, for example from Let's Encrypt with `certbot`, with the command that fits the way you choose in step 4. The lines below expect its usual place, `/etc/letsencrypt/live/tasklace.my-school.example/`.

   ```sh
   # Behind Apache
   sudo apt install certbot python3-certbot-apache
   sudo certbot certonly --apache -d tasklace.my-school.example
   # Behind nginx
   sudo apt install certbot python3-certbot-nginx
   sudo certbot certonly --nginx -d tasklace.my-school.example
   # Alone, without a web server: the port 80 must be open and free, now and at each renewal
   sudo apt install certbot
   sudo certbot certonly --standalone -d tasklace.my-school.example
   ```

   `certonly` gets the certificate without changing the settings of Apache or nginx, which step 4 gives. The `certbot` package of Debian and Ubuntu renews the certificate on its own before it runs out.

3. Save this service as `/etc/systemd/system/tasklace-relay.service`. It runs the relay as a user without rights, made up when it starts, and keeps the plans in `/var/lib/tasklace-relay`. Write in `ExecStart` the path that `command -v node` gives:

   ```ini
   [Unit]
   Description=Tasklace relay
   After=network-online.target
   Wants=network-online.target

   [Service]
   WorkingDirectory=/opt/tasklace/relay
   ExecStart=/usr/local/bin/node src/main.ts
   Environment=NODE_ENV=production RELAY_HOST=127.0.0.1 RELAY_PORT=8080 RELAY_TRUST_PROXY=1
   Environment=RELAY_DATA_DIR=/var/lib/tasklace-relay
   DynamicUser=yes
   StateDirectory=tasklace-relay
   CapabilityBoundingSet=
   NoNewPrivileges=yes
   ProtectSystem=strict
   ProtectHome=yes
   PrivateTmp=yes
   PrivateDevices=yes
   ProtectKernelTunables=yes
   ProtectKernelModules=yes
   ProtectControlGroups=yes
   RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   Then start it, and check that it answers on this server only:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now tasklace-relay
   curl -I http://127.0.0.1:8080
   ```

   `journalctl -u tasklace-relay` shows its messages.

4. Pass the connections on to the relay, with one of the three ways below.

**Behind Apache** (2.4.47 or later, which passes WebSocket connections on). Turn on the modules it needs, then save the site below as `/etc/apache2/sites-available/tasklace-relay.conf`:

```sh
sudo a2enmod proxy proxy_http ssl
```

```apache
<VirtualHost *:80>
    ServerName tasklace.my-school.example
    Redirect permanent / https://tasklace.my-school.example/
</VirtualHost>

<VirtualHost *:443>
    ServerName tasklace.my-school.example
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/tasklace.my-school.example/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/tasklace.my-school.example/privkey.pem
    ProxyPass / http://127.0.0.1:8080/ upgrade=websocket
</VirtualHost>
```

```sh
sudo a2ensite tasklace-relay
sudo systemctl reload apache2
```

On Debian and Ubuntu, Apache writes every connection to a site without a log of its own in `other_vhosts_access.log`; `sudo a2disconf other-vhosts-access-log` stops it.

**Behind nginx.** Save the site below as `/etc/nginx/sites-available/tasklace-relay`. Its line `access_log off;` keeps nginx from writing the address of each connection:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name tasklace.my-school.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name tasklace.my-school.example;
    ssl_certificate /etc/letsencrypt/live/tasklace.my-school.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tasklace.my-school.example/privkey.pem;
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```sh
sudo ln -s /etc/nginx/sites-available/tasklace-relay /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

**Alone, without a web server** (systemd 248 or later: Debian 12, Ubuntu 22.04 or later). The relay then listens on the port 443 itself and serves the certificate, which `systemd` hands it when it starts, so that the relay never needs the right to read the private key. In the service, replace the line `Environment=NODE_ENV=production RELAY_HOST=127.0.0.1 RELAY_PORT=8080 RELAY_TRUST_PROXY=1` and the line `CapabilityBoundingSet=` with:

```ini
Environment=NODE_ENV=production RELAY_HOST=0.0.0.0 RELAY_PORT=443
Environment=RELAY_TLS_CERT=%d/certificate RELAY_TLS_KEY=%d/key
LoadCredential=certificate:/etc/letsencrypt/live/tasklace.my-school.example/fullchain.pem
LoadCredential=key:/etc/letsencrypt/live/tasklace.my-school.example/privkey.pem
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

Then run `sudo systemctl daemon-reload` and `sudo systemctl restart tasklace-relay`. The only right the relay gets is to listen on a port below 1024. Set `RELAY_TRUST_PROXY=1` only when Apache or nginx is in front of the relay; otherwise anyone could choose the address the limits count them under.

5. Check from another computer with `curl -I https://tasklace.my-school.example`, which gives the status `426`, and give people the address `wss://tasklace.my-school.example`.

When `certbot` renews the certificate, the program that serves it must read it again. Save this file as `/etc/letsencrypt/renewal-hooks/deploy/tasklace-relay`, with `systemctl reload nginx` instead behind nginx, or `systemctl restart tasklace-relay` for the relay alone, and make it executable with `sudo chmod +x`:

```sh
#!/bin/sh
systemctl reload apache2
```

## Settings

The relay reads its settings and limits from environment variables. The defaults suit a school or a company of a few hundred people.

| Variable                                   | Default             | What it sets                                                                                                                                                           |
| ------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_HOST`                               | `127.0.0.1`         | Address the relay listens on: `0.0.0.0` in the Docker image and for the relay alone                                                                                    |
| `RELAY_PORT`                               | 8080                | Port the relay listens on: 443 for the relay alone                                                                                                                     |
| `RELAY_DATA_DIR`                           | `data`              | Folder of the plans, from the folder the relay starts in: `/data` in the Docker image                                                                                  |
| `RELAY_TLS_CERT` and `RELAY_TLS_KEY`       | none                | Files of the certificate and of its private key, set together, for the relay alone; without them, the relay expects a web server in front of it                        |
| `RELAY_MAX_ROOMS`                          | 4096                | Plans the relay holds at once                                                                                                                                          |
| `RELAY_MAX_ROOM_BYTES`                     | 268435456 (256 MiB) | Encrypted size of one plan with its history                                                                                                                            |
| `RELAY_MAX_STORED_BYTES`                   | 1073741824 (1 GiB)  | Size of all the plans together                                                                                                                                         |
| `RELAY_MAX_CONNECTIONS`                    | 1024                | People connected at once                                                                                                                                               |
| `RELAY_MAX_CONNECTIONS_PER_ADDRESS`        | 32                  | People connected at once from one IP address                                                                                                                           |
| `RELAY_CONNECTIONS_PER_MINUTE_PER_ADDRESS` | 64                  | New connections per minute from one IP address                                                                                                                         |
| `RELAY_ROOM_EXPIRY_DAYS`                   | 90                  | Days after which a plan nobody opened is removed                                                                                                                       |
| `RELAY_TRUST_PROXY`                        | `0`                 | `1` when a proxy in front of the relay gives the address of each person: set by the Compose file, since Caddy is that proxy, and in the service behind Apache or nginx |

A plan also takes at most 64 people at once. When many people work from one site behind a single public IP address, raise the two limits per address. To change a setting, create a file named `docker-compose.override.yml` next to `docker-compose.yml`, which Docker Compose reads on its own and which updates never touch:

```yaml
services:
  relay:
    environment:
      RELAY_MAX_CONNECTIONS_PER_ADDRESS: '256'
      RELAY_CONNECTIONS_PER_MINUTE_PER_ADDRESS: '512'
```

Then run `docker compose up -d` again. A wrong value keeps the relay from starting, which Docker Compose reports; `docker compose logs relay` then names the setting and the values it takes.

Without Docker, add each setting to an `Environment=` line of the service, for example `Environment=RELAY_MAX_CONNECTIONS_PER_ADDRESS=256`, then run `sudo systemctl daemon-reload` and `sudo systemctl restart tasklace-relay`; `journalctl -u tasklace-relay` names a wrong value.

## Look after the relay

- **Updates.** Each version of Tasklace fixes the exact versions of the images it uses. The relay and the application must be of the same version: `git pull` gets the latest files, and once Tasklace publishes numbered versions, `git checkout` followed by a version gets the one people use. To update, get the new files and build again:

  ```sh
  git pull
  docker compose up -d --build
  docker image prune -f
  ```

  Without Docker, get the new files, install the package again and restart the relay:

  ```sh
  cd /opt/tasklace && sudo git pull
  cd relay && sudo npm ci --omit=dev --ignore-scripts
  sudo systemctl restart tasklace-relay
  ```

  People who are connected see the relay come back on its own; their changes are kept meanwhile. Keep the system of the server up to date as well.

- **Backups** are optional. Every person in a plan keeps a full copy of it on their own computer, so if the relay loses its plans, the owner of each plan shares it again and sends the new links. To keep a copy of the encrypted plans anyway:

  ```sh
  docker compose cp relay:/data ./relay-backup-$(date +%F)
  ```

  Without Docker, the plans are in `/var/lib/private/tasklace-relay`, where `systemd` keeps the folder of a user made up when the service starts.

- **Removing a plan.** The relay cannot tell which plan is which, by design. Someone with the link to edit a plan empties its place on the relay with **Make new links** in Tasklace. A plan nobody opens is removed after `RELAY_ROOM_EXPIRY_DAYS` days.

- **Stopping the relay** keeps its plans: `docker compose down`, or `sudo systemctl stop tasklace-relay` without Docker. To remove the plans as well: `docker compose down --volumes`, or remove `/var/lib/private/tasklace-relay`.

## Try it on a single computer

To see the relay work before setting up a server, run it with Docker on your own computer, under the name `localhost`. Caddy then makes its own certificate, which you tell only one start of Tasklace to trust:

```sh
cd tasklace/relay
echo "RELAY_DOMAIN=localhost" > .env
docker compose up -d --build
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Caddy makes its certificate a few seconds after it starts: if the copy fails, open `https://localhost` once in a browser, or wait a little, and copy again.

Start Tasklace from a terminal where the environment variable `NODE_EXTRA_CA_CERTS` holds the full path of `caddy-root.crt`, and share through `wss://localhost`. Started otherwise, Tasklace refuses this relay, as it would refuse any relay whose certificate is not valid. When you are done, remove everything with `docker compose down --volumes`.

## Troubleshooting

| Tasklace says                                             | What it means                                                                                                 | What to do                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The relay … did not answer                                | Tasklace cannot reach the server                                                                              | Check the address, the domain name, the port 443, and `docker compose ps` or `systemctl status tasklace-relay` |
| The relay … could not prove who it is                     | The certificate is missing, out of date, or for another name                                                  | Check that the address typed is the domain name, and the messages of Caddy, Apache, nginx or the relay         |
| A relay must be reached with wss://                       | The address typed starts with `ws://` or `https://`                                                           | Give the address starting with `wss://`                                                                        |
| Type the address of the relay as it is given              | The address typed is not one, for example without `wss://`                                                    | Give the whole address, starting with `wss://`                                                                 |
| Too many connections come from your network               | `RELAY_MAX_CONNECTIONS_PER_ADDRESS` is reached                                                                | Raise both limits per address for a site behind a single IP address                                            |
| Tasklace sent too much to the relay … at once             | `RELAY_CONNECTIONS_PER_MINUTE_PER_ADDRESS` is reached, or one person sent too much at once                    | Raise both limits per address for a site behind a single IP address                                            |
| The relay … takes no more plans for now                   | `RELAY_MAX_ROOMS`, `RELAY_MAX_STORED_BYTES` or `RELAY_MAX_CONNECTIONS` is reached                             | Raise the limits                                                                                               |
| The relay … could not keep this plan because of a problem | The relay could not read or write its files, for example on a full disk                                       | Read `docker compose logs relay` or `journalctl -u tasklace-relay`, and free disk space                        |
| The relay keeps no more for this plan                     | The plan reached `RELAY_MAX_ROOM_BYTES`                                                                       | Raise the limit; the changes stay on each computer meanwhile                                                   |
| This plan already has as many people as the relay … takes | The plan has 64 people connected                                                                              | Wait for someone to leave                                                                                      |
| This plan was given new links                             | Someone with the link to edit chose **Make new links**                                                        | Ask the owner of the plan for the new links                                                                    |
| This plan is not on the relay                             | The plan was given new links, nobody opened it for `RELAY_ROOM_EXPIRY_DAYS` days, or the relay lost its plans | Ask who sent the link for the new links, or forget the plan in **Share** and share it again                    |
| The relay … uses another version of Tasklace              | The relay and the application are of different versions                                                       | Update the relay and Tasklace to the same version                                                              |
| The relay … sent something Tasklace could not read        | The relay is of another version, or something between Tasklace and the relay changed the data                 | Update the relay and Tasklace to the same version, and check the web server in front of the relay              |
