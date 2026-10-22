# open-download-manager

[![CI](https://github.com/LofisMusk/open-download-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/LofisMusk/open-download-manager/actions/workflows/ci.yml)

A simple web UI for downloading files: paste a URL, pick a destination folder and click.
The app downloads on the server side (streaming) and writes atomically (`.part` file first,
then `rename`). One dependency (Express), no build step — runs in Docker or plain Node ≥ 20.

## Quick start (docker compose)

```bash
cp .env.example .env
# edit .env: set AUTH_PASS (login password) and optionally the LAN port
docker compose up -d --build
```

Then open `http://SERVER:DM_HOST_PORT` and log in with your user/password. The compose file
ships with an optional Traefik subdomain label (`subdomain: downloader`) — keep or remove it
depending on whether you run a shared Traefik network (see the `proxy` network at the bottom).

## Configuration

All settings are environment variables (in `.env` for docker compose):

| Variable | Default | Description |
|---|---|---|
| `AUTH_USER` | `admin` | Login for the web UI (Basic auth) |
| `AUTH_PASS` | *(empty)* | Password for the web UI. Empty = no authentication at all (warning in logs) |
| `DM_HOST_PORT` | `3000` | Host port published by docker compose |
| `BLOCK_PRIVATE_IPS` | `false` | `true` = reject URLs that resolve to private/LAN IPs (SSRF protection); set `false` if you download from a NAS on your LAN |
| `MAX_CONCURRENT_JOBS` | `3` | Max parallel downloads |
| `QBT_API_URL` | `http://qbittorrent:8081/api/v2` | WebUI API of your qBittorrent container (must be reachable from this container) |
| `QBT_USER` / `QBT_PASS` | `admin` / *(empty)* | Login for the qBittorrent WebUI. Empty `QBT_PASS` = integration off (tab and speed cap inactive) |
| `NTFY_URL` | `http://ntfy` | Address of your ntfy server (Docker DNS name works if both are on the same network) |
| `NTFY_TOPIC` | `downloads` | Notification topic. Empty = notifications off |
| `NTFY_USER` / `NTFY_PASS` | `admin` / *(empty)* | Login for ntfy, if your server requires authentication (otherwise requests get 401) |
| `ROOT_DIR` | `/data` | Root directory inside the container that destinations are resolved against |
| `PORT` | `3000` | Port inside the container |

## API

Everything is under `/api`, authenticated with Basic auth
(`Authorization: Basic base64(login:password)`, e.g. with curl: `-u admin:your-password`):

- `POST /api/jobs` — body `{"url": "https://…", "dest": "optional/sub/dir"}` → `201` with the job
- `GET  /api/jobs` — list of jobs + progress (`receivedBytes`, `totalBytes`)
- `DELETE /api/jobs/:id` — cancel (or remove a finished history entry and its file)
- `GET  /api/dirs` — existing folders (autocomplete in the UI)
- `GET  /api/files?p=…` — browse a folder (files with size/mtime, subfolders)
- `DELETE /api/file?p=…`, `DELETE /api/dir?p=…` — delete from the download root
- `GET  /api/status`, `GET /healthz`
- `GET  /api/qbt/status` — qBittorrent configured/reachable + current DL limit (bytes/s, 0 = unlimited)
- `GET  /api/qbt/torrents` — torrents that are not finished/seeding yet
- `POST /api/qbt/torrents` — add: `{"magnet": "magnet:?xt=…"}` or `{"b64": "<.torrent file>", "filename": "x.torrent"}`
- `POST /api/qbt/pause`, `POST /api/qbt/resume` — body `{"hashes": ["…"]}`

## qBittorrent (tab + speed cap)

The manager wraps a real qBittorrent client container:

- **qBittorrent tab** — shows torrents that are still in progress (paused/queued/meta/error;
  seeding ones are hidden). They can be paused/resumed, and new torrents added via magnet link
  or `.torrent` file. Operations go straight to the qBittorrent WebUI API — the real client does
  the work, this manager just relays it.
- **Speed limit mirroring** — every 30 s the manager reads the current global download limit
  from the qBittorrent API (e.g. the one set by your own schedule script) and caps the
  **combined** rate of all its own downloads with it. The effective limit is shown as a
  "Download speed cap" banner in the UI. If qBittorrent stops answering (2 refreshes in a row),
  the cap is lifted.
- Compatible with Web API v4 and ≥5 (`pause`/`stop` endpoint names, `mt`/`urls` parameter).

## ntfy (push notifications)

When a download ends, the manager pushes a notification to your self-hosted ntfy server:

- **Download finished** → title "Download finished" + file path and size.
- **Download failed** → "Download failed" (higher priority) + the error message.
- Cancelled jobs (🗑 clicked mid-download) stay silent.

The push is fire-and-forget with a 5 s timeout — a dead ntfy never breaks a job completion, it
only leaves a line in the logs. Authentication: Basic auth of your ntfy server (if login is
enabled there).

## File paths & naming

- `dest` is relative to `ROOT_DIR`; folders are created automatically.
- File name comes from `Content-Disposition`, otherwise from the URL. Name collisions get a
  `-1`, `-2`, … suffix.
- A download finishes with an atomic `rename`, so the final file is never half-written.

### Interrupted downloads (restart / redeploy safety)

Jobs are tracked in memory, but every running download writes a small `<id>.part.meta.json`
sidecar next to its `.part` file. On startup, leftover `.part` files are restored as
**interrupted** jobs, so a `docker compose up`/rebuild mid-download (or a power loss) leaves
nothing orphaned on disk:

- the UI shows the interrupted job with the downloaded/total size and a **Resume** button
  (`POST /api/jobs/:id/resume`) — resume continues via HTTP `Range`; if the server ignores
  Range or the file changed, it transparently starts over from byte 0;
- on `SIGTERM`/`SIGINT` in-flight downloads are kept as resumable (second signal force-exits),
  and ntfy announces a "Download paused" for each of them;
- deleting an interrupted job (🗑) removes the partial file and reclaims its space.

## Security

- Container runs as non-root (`node` user, uid 1000).
- Credentials compared with `timingSafeEqual` (SHA-256 hashes, no length leak).
- Only `http:`/`https:`; optional SSRF filter for private IPs.
- Destination path validation + symlink escape protection (`realpath`).
- 4 MB body limit (for `.torrent` uploads), concurrent-job limit, idle watchdog
  (job without data for >15 min → abort).
- CSP `default-src 'self'`, `nosniff`, no inline scripts.

## Deployment notes

The compose file follows a common self-hosted pattern: the service joins an external Docker
network named `proxy` (the one your reverse proxy/Traefik uses), so it can reach sibling
containers (qBittorrent, ntfy) by name. If you don't use that pattern, remove the `proxy`
entry from `networks:` — LAN access via `DM_HOST_PORT` works either way.

Adjust the `volumes:` line to wherever you want the files to live on the host
(the example uses `./downloads`).

### Updating / auto-deploy

The compose file pulls the image CI pushes on every push to `main`:

```bash
docker compose pull && docker compose up -d   # update in place (safe mid-download:
                                              # running jobs are kept as resumable)
```

Optionally, the CI workflow deploys by itself after each image push. Enable it by setting
repo variables `DM_DEPLOY_HOST` + `DM_DEPLOY_USER` and secret `DM_DEPLOY_SSH_KEY`
(a deploy key for the server user). The host must be reachable from GitHub's runners
(Tailscale or a port forward) — keep it in the variable, not in the workflow file.

## Running without Docker (development)

```bash
npm install
ROOT_DIR=/tmp/dm-test AUTH_USER=admin AUTH_PASS=pass PORT=3999 node server.js
# login: admin / pass
# http://localhost:3999
```

Smoke test (starts the real server, downloads a file end-to-end):

```bash
npm test
```

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`): on push to `main` and on tags it runs the smoke
test, then builds and pushes the Docker image to GHCR:

- `ghcr.io/lofismusk/open-download-manager:<short-sha>` — every push to `main` / tag
- `ghcr.io/lofismusk/open-download-manager:latest` — main branch
- `ghcr.io/lofismusk/open-download-manager:vX.Y.Z` — version tags

Pull it with `docker pull ghcr.io/lofismusk/open-download-manager:latest` if you prefer running
the prebuilt image over building locally.
