# LayerCove installation scripts

These scripts install LayerCove from `Timpan4/layercove`. Runtime identifiers inherited from Bambuddy remain unchanged where renaming would disconnect existing services or data: the Compose service/container and volumes, native `bambuddy` service account/service, launchd label, database filename, and backup filenames are compatibility interfaces.

## Docker installation (recommended)

Linux/macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/Timpan4/layercove/main/install/docker-install.sh -o docker-install.sh
chmod +x docker-install.sh
./docker-install.sh
```

Windows with Docker Desktop:

```powershell
powershell -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/Timpan4/layercove/main/install/docker-install.ps1 -OutFile docker-install.ps1; .\docker-install.ps1"
```

The Docker installers default to a fresh `layercove` directory, download the LayerCove Compose file, and pull `ghcr.io/timpan4/layercove:latest`. `--build`/`-Build` clones this repository and builds the image locally instead. The bundled Spoolman service is not installed or started by default; see [optional Spoolman operations](../UPDATING.md#optional-bundled-spoolman) to opt in without changing an external Spoolman configuration.

| Script | Platform | Important options |
|---|---|---|
| `docker-install.sh` | Linux, macOS | `--path`, `--port`, `--tz`, `--build`, `--yes` |
| `docker-install.ps1` | Windows Docker Desktop | `-InstallPath`, `-Port`, `-TimeZone`, `-Build`, `-Yes` |

Docker Desktop does not provide the Linux host networking used for automatic discovery. The installers enable the HTTP port mapping; add printers manually by address and explicitly enable any virtual-printer ports you require.

## Native installation

Linux/macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/Timpan4/layercove/main/install/install.sh -o install.sh
chmod +x install.sh
./install.sh
```

`install.sh` defaults to `/opt/layercove` on Linux and `$HOME/layercove` on macOS. It supports `--path`, `--port`, `--bind`, `--tz`, `--data-dir`, `--log-dir`, `--debug`, `--log-level`, `--branch`, `--no-service`, and `--yes`.

The service account and service name remain `bambuddy`. This is deliberate: an existing `/opt/bambuddy` installation can point `origin` to LayerCove and update without creating a second service or moving its data. Fresh installations show LayerCove in service descriptions and UI while using the compatible runtime identifiers.

Examples:

```bash
./install.sh --path /srv/layercove --port 3000 --tz Europe/Stockholm --yes
./install.sh --no-service --yes
```

## Updating

Read [`../UPDATING.md`](../UPDATING.md) before changing an existing deployment. In summary:

- Docker: back up, download the LayerCove Compose file separately, review/merge local settings, run `docker compose config`, then `docker compose pull && docker compose up -d`.
- Native: run the updater inside the installed checkout. It derives the install root from its own path and retains the compatible service name.
- Never use `docker compose down -v` during an upgrade; it deletes the named volumes.
- Keep the previous image digest or Git commit and the backup until health and representative printer workflows pass.

Linux native updater:

```bash
sudo bash /path/to/layercove/install/update.sh
```

Useful compatibility overrides remain available:

```bash
INSTALL_DIR=/opt/bambuddy SERVICE_NAME=bambuddy sudo --preserve-env=INSTALL_DIR,SERVICE_NAME bash /opt/bambuddy/install/update.sh
BACKUP_MODE=require BAMBUDDY_API_KEY=bb_xxx sudo --preserve-env=BACKUP_MODE,BAMBUDDY_API_KEY bash /opt/bambuddy/install/update.sh
```

The `BAMBUDDY_API_KEY` name and `bambuddy-backup-*.zip` files are retained interfaces, not stale product text.

## Service management

Linux:

```bash
sudo systemctl status bambuddy
sudo journalctl -u bambuddy -f
```

macOS:

```bash
launchctl list | grep com.bambuddy.app
```

Docker:

```bash
docker compose ps
docker compose logs -f bambuddy
```

## Requirements and boundaries

- Native: Python 3.10+, Node.js 20+, Git, and FFmpeg.
- Docker: Docker Engine with Compose v2, or Docker Desktop.
- LayerCove is intended for a trusted private network or authenticated access layer. Do not publish Moonraker or printer endpoints directly.
- LayerCove-specific behavior and deployment guidance lives in this repository. The Bambuddy wiki can describe inherited Bambu features but is not authoritative for LayerCove releases, Moonraker behavior, or upgrade destinations.

Report LayerCove installation issues at <https://github.com/Timpan4/layercove/issues>.
