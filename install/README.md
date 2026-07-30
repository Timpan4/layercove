# LayerCove installation scripts

LayerCove supports one production deployment path: Docker Compose. The image build owns the Python environment and generates the frontend bundle with the repository-pinned Bun lockfile.

## Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/Timpan4/layercove/main/install/docker-install.sh -o docker-install.sh
chmod +x docker-install.sh
./docker-install.sh
```

## Windows with Docker Desktop

```powershell
powershell -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/Timpan4/layercove/main/install/docker-install.ps1 -OutFile docker-install.ps1; .\docker-install.ps1"
```

The installers default to a fresh `layercove` directory, download the LayerCove Compose file, and pull `ghcr.io/timpan4/layercove:latest`. `--build`/`-Build` clones this repository and builds the image locally instead.

| Script | Platform | Important options |
|---|---|---|
| `docker-install.sh` | Linux, macOS | `--path`, `--port`, `--tz`, `--build`, `--yes` |
| `docker-install.ps1` | Windows Docker Desktop | `-InstallPath`, `-Port`, `-TimeZone`, `-Build`, `-Yes` |

Docker Desktop does not provide the Linux host networking used for automatic discovery. The installers enable the HTTP port mapping; add printers manually by address and explicitly enable any virtual-printer ports you require.

## Updating

Read [`../UPDATING.md`](../UPDATING.md) before changing a deployment. Never use `docker compose down -v` during an update because it deletes named volumes.

```bash
cd /path/to/layercove
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f layercove
```

## Requirements and boundaries

- Docker Engine with Compose v2, or Docker Desktop.
- LayerCove is intended for a trusted private network or authenticated access layer. Do not publish Moonraker or printer endpoints directly.
- Native Python services and self-contained Windows installers are not supported production targets. Use `scripts/dev.sh` only for development.

Report installation issues at <https://github.com/Timpan4/layercove/issues>.
