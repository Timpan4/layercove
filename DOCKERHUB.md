# LayerCove

**Self-hosted print orchestration, archive, and inventory for Bambu Lab and Klipper/Moonraker printers.**

## Quick start

```bash
mkdir layercove && cd layercove
curl -O https://raw.githubusercontent.com/Timpan4/layercove/main/docker-compose.yml
docker compose up -d
```

Open **http://localhost:8000** and add a printer.

## Image

`ghcr.io/timpan4/layercove:latest` supports `linux/amd64` and `linux/arm64`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TZ` | `UTC` | IANA timezone |
| `PORT` | `8000` | Web UI port |
| `PUID` | `1000` | User ID for persisted files |
| `PGID` | `1000` | Group ID for persisted files |
| `DATABASE_URL` | SQLite in `/app/data/layercove.db` | Explicit database connection URL |

Persistent data lives under `/app/data`; logs live under `/app/logs`. The checked-in Compose file creates `layercove_data` and `layercove_logs` volumes.

Docker Desktop does not support the Linux host networking used for discovery. Use the documented port mapping and add printers manually by address on macOS and Windows.

## Updating

```bash
docker compose pull
docker compose up -d
```

Take a backup before updating and never run `docker compose down -v` against data you need.

## Links

- Source and issues: <https://github.com/Timpan4/layercove>
- License: [MIT](LICENSE)
