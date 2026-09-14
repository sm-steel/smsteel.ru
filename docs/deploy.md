# Deployment

The site is served by a single `nginx:alpine` container on **moscow**
(`moscow.smsteel.ru`), behind that host's shared traefik. Pushing to `main`
runs [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml),
which builds `dist/` and rsyncs it onto the host. Nothing else is
automated — in particular, the workflow never creates or restarts the
container.

```
/opt/smsteel/                     # on moscow; mirrors this repo's root
├── docker-compose.yml            # committed here, copy it up by hand
├── nginx.conf                    # committed here, copy it up by hand
└── dist/                         # the rrsync jail; CI writes only here
```

`docker-compose.yml` and `nginx.conf` live at this repo's root rather than
in a `deploy/` subdirectory on purpose: the compose file bind-mounts
`./dist`, the same relative path the build writes to, so the file that is
committed here is byte-for-byte the file that runs on the host.

## Routine deploys

Push to `main`. CI builds and rsyncs, in two steps:

1. everything except `index.html`, with `--delete` (prunes hashed asset
   filenames from older builds)
2. `index.html` last

so there is never a moment where the served `index.html` references an
asset that has not landed yet. The container serves the bind-mounted
directory directly — no restart is needed, and none happens.

**Changes to `docker-compose.yml` or `nginx.conf` are not deployed by CI.**
The deploy key is jailed to `dist/` (see below). Copy those up yourself and
re-run `docker compose up -d`.

## Host prerequisites

None of this is automated yet; a rebuilt host needs all of it before the
first CI deploy can succeed.

**1. The `proxy` network** — shared with traefik and the host's other
routed stacks, owned by no stack:

```bash
docker network create proxy   # if it does not already exist
```

**2. The stack:**

```bash
mkdir -p /opt/smsteel/dist
# copy docker-compose.yml and nginx.conf from this repo to /opt/smsteel/
cd /opt/smsteel && docker compose up -d
```

The container will run with an empty `dist/` until the first deploy fills
it.

**3. The `deploy` user and its rsync jail** — CI authenticates as an
unprivileged user whose key can write to exactly one directory:

```bash
apt-get install -y rsync            # provides /usr/bin/rrsync
adduser --disabled-password --gecos "" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
chown -R deploy:deploy /opt/smsteel/dist
```

`/home/deploy/.ssh/authorized_keys` (mode 600, owned by `deploy`) holds one
line — the forced command is what makes the key harmless if it ever leaks:

```
command="/usr/bin/rrsync /opt/smsteel/dist",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAv6cA4WjNaPnm0IaioVgHL6fq6ugWxSc1lTsKK8H+h1 github-actions-deploy
```

Because the key is jailed, the workflow's rsync destination is a bare colon
(`deploy@moscow.smsteel.ru:`) — `rrsync`'s restricted root — not the
absolute path repeated.

The matching **private** key is the `DEPLOY_SSH_KEY` repository secret. It
is not stored anywhere else; if it is ever lost, generate a new keypair,
replace the secret, and replace the line above.

**4. The host key pin.** The workflow pins moscow's SSH host key into
`known_hosts`. A rebuilt host gets a new host key, so that line has to be
updated in `deploy.yml` at the same time.

## TLS and routing

Traefik (`/opt/traefik` on moscow, a separate stack) terminates TLS and
routes ``Host(`smsteel.ru`)`` to this container's port 80, driven entirely
by the labels in `docker-compose.yml`. Certificates come from that traefik's
`letsencrypt` resolver; this stack owns no certificate state of its own.

DNS: `smsteel.ru` is an A record at 1cloud.ru pointing at moscow.
