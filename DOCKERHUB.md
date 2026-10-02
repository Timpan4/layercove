# LayerCove

Self-hosted slicing, print management, archive, and inventory for Bambu Lab and Klipper/Moonraker printers.

## Quick start

```bash
mkdir layercove && cd layercove
curl -fsSLO https://raw.githubusercontent.com/Timpan4/layercove/main/docker-compose.yml
docker compose up -d
```

Open **http://localhost:8000** and add a printer.

The Compose file uses host networking for printer discovery. Docker Desktop on macOS and Windows does not support it: comment out `network_mode: host`, enable the `ports:` block, and add printers by address.

## Image

`ghcr.io/timpan4/layercove:latest` is built for `linux/amd64` and `linux/arm64`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TZ` | `Europe/Berlin` (Compose file) | IANA time zone |
| `PORT` | `8000` | Web UI port |
| `PUID` | `1000` | User ID that owns persisted files |
| `PGID` | `1000` | Group ID that owns persisted files |
| `DATABASE_URL` | SQLite at `/app/data/layercove.db` | Database connection URL, for example PostgreSQL |
| `SLICER_API_URL` | `http://localhost:3003` | Orca Slicer API sidecar |
| `LAYERCOVE_EXTERNAL_ROOTS` | empty (disabled) | Colon-separated container paths allowed as external library folders |

Data lives in `/app/data` and logs in `/app/logs`. The Compose file mounts them as the `layercove_data` and `layercove_logs` volumes.

## Updating

Back up first through **Settings → Backup**, then:

```bash
docker compose pull
docker compose up -d
```

Never run `docker compose down -v`. It deletes the data volumes. See [UPDATING.md](https://github.com/Timpan4/layercove/blob/main/UPDATING.md) for rollback.

## Links

- Source and issues: <https://github.com/Timpan4/layercove>
- License: [AGPL-3.0-or-later](https://github.com/Timpan4/layercove/blob/main/LICENSE)
