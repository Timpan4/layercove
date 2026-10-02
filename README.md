<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/img/layercove-wordmark-light.svg">
    <img src="frontend/public/img/layercove-wordmark-dark.svg" alt="LayerCove" width="300">
  </picture>
</p>

<h1 align="center">LayerCove</h1>

<p align="center">
  <strong>Your printers. No cloud. Your rules.</strong><br>
  Vendor-neutral, self-hosted slicing, management, and monitoring for Bambu Lab and Klipper/Moonraker printers.
</p>

<p align="center">
  <a href="https://github.com/Timpan4/layercove/actions/workflows/ci.yml"><img src="https://github.com/Timpan4/layercove/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/Timpan4/layercove/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Timpan4/layercove?style=flat-square" alt="License"></a>
  <a href="https://github.com/Timpan4/layercove/issues"><img src="https://img.shields.io/github/issues/Timpan4/layercove?style=flat-square" alt="Issues"></a>
</p>

> [!IMPORTANT]
> LayerCove is an independent modified fork of [Bambuddy](https://github.com/maziggy/bambuddy). It is not affiliated with or endorsed by Bambuddy's maintainer, Bambu Lab, Klipper, Moonraker, or OrcaSlicer.

## Project status

LayerCove keeps the inherited Bambu workflows and adds a Moonraker MVP: safe onboarding, live status and reconnect, standard `.gcode` upload/start, pause/resume/cancel, camera, queue/history integration, provider-aware slicing, and Spoolman accounting. Automated fake-Moonraker coverage is included. Physical Bambu and Klipper validation remain open and must pass before the multi-provider work is declared complete.

The primary workflow:

1. Upload an STL, STEP, or 3MF from a browser or the installed PWA.
2. Select OrcaSlicer printer, process, and filament profiles, then slice on the server.
3. Choose a Bambu or Moonraker printer and upload, or upload and start.
4. Monitor and control the print from the fleet UI.

## Security boundary

Run LayerCove on a trusted private network or behind an authenticated access layer such as Tailscale or Cloudflare Access. Do not expose printers or Moonraker to the public internet. LayerCove provides no generic URL proxy, shell, or G-code console. Read [SECURITY.md](SECURITY.md) before configuring reverse proxies, trusted headers, self-signed TLS, or remote access.

## Quick start

Requirements:

- Docker Engine with Compose v2, or Docker Desktop
- A Bambu Lab printer in Developer Mode, a Klipper printer with Moonraker, or both
- Network access from LayerCove to each printer
- OrcaSlicer profiles for server-side slicing

Pull the published image:

```bash
mkdir layercove && cd layercove
curl -fsSLO https://raw.githubusercontent.com/Timpan4/layercove/main/docker-compose.yml
docker compose pull
docker compose up -d
```

Or build from source:

```bash
git clone https://github.com/Timpan4/layercove.git
cd layercove
docker compose up -d --build
```

Open **http://localhost:8000**. The Compose file uses host networking on Linux so printer discovery works. Docker Desktop on macOS and Windows does not support host networking: comment out `network_mode: host`, enable the `ports:` block, and add printers by address. The [install scripts](install/README.md) do this for you.

The Compose file creates the `layercove` container and the `layercove_data` and `layercove_logs` volumes. The default SQLite database is `layercove.db`. LayerCove does not attach Bambuddy volumes or databases. Read [UPDATING.md](UPDATING.md) before replacing an existing Compose file.

### Bambu printers

Enable LAN/Developer Mode on the printer. To let LayerCove read thumbnails and slicer metadata, enable **Store sent files on external storage** in Bambu Studio or OrcaSlicer.

### Moonraker printers

Moonraker printers use standard `.gcode` files and need no AMS fields. See [docs/moonraker-configuration.md](docs/moonraker-configuration.md) for connection, TLS, upload, and Spoolman settings.

### Server-side slicing

Slicing runs in the [Orca Slicer API](https://github.com/Timpan4/orca-slicer-api) sidecar. Start its Compose stack beside LayerCove and set `SLICER_API_URL` if it is not at `http://localhost:3003`. See [docs/calibration.md](docs/calibration.md) for guided filament calibration, which uses the same sidecar.

## Features

### Printers and monitoring

- Real-time status over WebSocket for Bambu (MQTT) and Moonraker (HTTP/WebSocket) printers
- Live camera with one shared upstream stream per printer, snapshots, a Cam Wall grid, and an OBS overlay at `/overlay/:printerId`
- External cameras (MJPEG, RTSP, HTTP snapshot, USB/V4L2) with layer-based timelapse
- Printer controls: pause, resume, stop, light, speed, fans, temperatures, jog, and airduct mode where the printer supports them
- AMS slot configuration, load/unload, RFID re-read, remote drying, and AMS Filament Backup status
- HMS error log with the same action buttons Bambu Studio shows
- Heater and AMS humidity history charts
- Maintenance mode, which takes a printer out of dispatch, scheduling, and notifications without deleting it
- Optional AI failure detection through a self-hosted [Obico](https://github.com/TheSpaghettiDetective/obico-server) ML API

### Slicing

- Server-side slicing from the File Manager, Archives, and MakerWorld imports
- An Orca-style workbench with arrangement on the selected printer's bed, preview, and per-job settings
- Multi-plate slicing into one output file
- Profile sources: Bambu Cloud, Orca Cloud, local OrcaSlicer presets (`.orca_filament`, `.bbscfg`, `.bbsflmt`, `.zip`, `.json`), and Bambu Studio preset bundles
- Slicer pipelines that save a printer, process, filament, and bed-type selection for one-click reuse, with copy fan-out across a printer class
- Guided filament calibration for temperature, flow, pressure advance, retraction, and volumetric flow

### Queue and automation

- One queue for every print start, with Queue, History, and Timeline views
- Scheduled prints, batch quantities, staggered starts, and Shortest Job First ordering
- Model-based assignment ("any X1C"), filament validation, and lowest-remaining-spool preference
- Plate-clear confirmation, auto-print G-code snippets, and preheat/heat soak before queued prints
- Smart plugs (Tasmota, Home Assistant, MQTT, REST) with auto power on/off and per-print energy tracking
- Queue, ambient, and while-printing AMS drying on capable hardware

### Archive and library

- Automatic 3MF archiving with metadata, 3D preview, duplicate detection, and full-text search
- Reprint to any compatible printer with AMS mapping
- Per-archive print history and a filterable Print Log
- Timelapse editor (trim, speed, music)
- File Manager with folders, ZIP import, STL thumbnails, and read-only external folders (see `LAYERCOVE_EXTERNAL_ROOTS` in [docker-compose.yml](docker-compose.yml))
- MakerWorld import using your existing Bambu Cloud login
- Projects that group archives, plates, and parts

### Filament inventory

- Built-in spool inventory with AMS slot assignment and consumption tracking
- [Spoolman](https://github.com/Donkie/Spoolman) sync, with an optional bundled Spoolman service (see [UPDATING.md](UPDATING.md#optional-bundled-spoolman))
- Per-spool cost tracking, storage locations, and printable spool labels with QR codes
- SpoolBuddy, a Raspberry Pi NFC reader and scale station (see [spoolbuddy/README.md](spoolbuddy/README.md))

### Virtual printer

- Emulates a Bambu printer so Bambu Studio and OrcaSlicer can send prints to LayerCove
- Archive, Review, Queue, and Proxy modes; Proxy mode relays to a real printer over TLS for remote printing
- SSDP discovery on the same LAN, or manual IP entry over VPN

### Notifications and integrations

- WhatsApp, Telegram, Discord, email, Pushover, ntfy, Home Assistant, and webhooks
- Quiet hours, daily digest, and customizable templates
- MQTT publishing, Prometheus metrics, and an interactive API browser
- Scheduled local backups and GitHub backup of profiles and settings

### Authentication

- Optional authentication with group-based permissions; default groups are Administrators, Operators, and Viewers
- API keys owned by their creator, with opt-in scopes
- TOTP and email two-factor authentication
- OIDC single sign-on (see [docs/authentication/entra-id.md](docs/authentication/entra-id.md)) and LDAP
- SMTP onboarding and self-service password reset

The UI is a mobile-friendly PWA translated into 11 languages.

<details>
<summary><strong>Screenshots</strong></summary>

These screenshots predate the LayerCove rebrand and the current printer card layout.

<p align="center">
  <img src="docs/screenshots/printers.png" alt="Printers" width="800">
  <br><em>Printer monitoring with AMS status</em>
</p>

<p align="center">
  <img src="docs/screenshots/archives.png" alt="Archives" width="800">
  <br><em>Print archive with 3D preview and project assignment</em>
</p>

<p align="center">
  <img src="docs/screenshots/reprint_ams_mapping.png" alt="Reprint AMS mapping" width="800">
  <br><em>Reprint with AMS filament mapping</em>
</p>

<p align="center">
  <img src="docs/screenshots/edit-timelapse.png" alt="Timelapse editor" width="800">
  <br><em>Timelapse editor</em>
</p>

<p align="center">
  <img src="docs/screenshots/projects.png" alt="Projects" width="800">
  <br><em>Projects</em>
</p>

<p align="center">
  <img src="docs/screenshots/project-detail-1.png" alt="Project detail" width="800">
  <br><em>Project detail with assigned archives</em>
</p>

<p align="center">
  <img src="docs/screenshots/project-detail-2.png" alt="Project timeline" width="800">
  <br><em>Project timeline and print history</em>
</p>

<p align="center">
  <img src="docs/screenshots/print-queue.png" alt="Print queue" width="800">
  <br><em>Print queue</em>
</p>

<p align="center">
  <img src="docs/screenshots/schedule-print.png" alt="Schedule print" width="800">
  <br><em>Scheduling a print</em>
</p>

<p align="center">
  <img src="docs/screenshots/statistics.png" alt="Statistics" width="800">
  <br><em>Statistics dashboard</em>
</p>

<p align="center">
  <img src="docs/screenshots/maintenance-1.png" alt="Maintenance" width="800">
  <br><em>Maintenance tracking per printer</em>
</p>

<p align="center">
  <img src="docs/screenshots/maintenance-2.png" alt="Maintenance settings" width="800">
  <br><em>Maintenance types and intervals</em>
</p>

<p align="center">
  <img src="docs/screenshots/cloud_profiles-1.png" alt="Cloud profiles" width="800">
  <br><em>Bambu Cloud filament profiles</em>
</p>

<p align="center">
  <img src="docs/screenshots/cloud_profiles-2.png" alt="Cloud profile editor" width="800">
  <br><em>Filament preset editor</em>
</p>

<p align="center">
  <img src="docs/screenshots/k_profiles-1.png" alt="K-profiles" width="800">
  <br><em>Pressure advance (K-factor) profiles</em>
</p>

<p align="center">
  <img src="docs/screenshots/k_profiles-2.png" alt="K-profile editor" width="800">
  <br><em>K-factor profile editor</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings-general.png" alt="General settings" width="800">
  <br><em>General settings</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings-powerplugs.png" alt="Smart plugs" width="800">
  <br><em>Smart plug control and energy monitoring</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings_notifications.png" alt="Notifications" width="800">
  <br><em>Notification providers</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings_api_keys.png" alt="API keys" width="800">
  <br><em>API keys and webhooks</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings-virtual-printer.png" alt="Virtual printer settings" width="800">
  <br><em>Virtual printer settings</em>
</p>

<p align="center">
  <img src="docs/screenshots/slicer-virtual-printer.png" alt="Virtual printer in the slicer" width="800">
  <br><em>Virtual printer in Bambu Studio/OrcaSlicer</em>
</p>

<p align="center">
  <img src="docs/screenshots/mqtt-debug-log.png" alt="MQTT debug log" width="800">
  <br><em>MQTT debug log</em>
</p>

<p align="center">
  <img src="docs/screenshots/quick_power_plug_sidebar.png" alt="Sidebar power plug control" width="400">
  <br><em>Sidebar power plug control</em>
</p>

</details>

## Supported printers

- **Bambu Lab:** inherited X1, X2, H2, P1, P2, A1, and A2 workflows, pending physical regression validation.
- **Klipper/Moonraker:** status, camera, standard G-code upload/start, common controls, queue/history, slicing, and Spoolman. Advanced macros, configuration editing, and generic G-code consoles are out of scope.

## Tech stack

| Component | Technology |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy |
| Frontend | React, TypeScript, Vite, Tailwind CSS, Bun |
| Database | SQLite (default) or PostgreSQL |
| Printer transports | Bambu MQTT/FTPS; Moonraker HTTP/WebSocket |
| Slicing | Orca Slicer API sidecar |
| Rust service | `layercove-rs` (see [rust/README.md](rust/README.md)) |

## Documentation

| Topic | Document |
|---|---|
| Updating, rollback, bundled Spoolman | [UPDATING.md](UPDATING.md) |
| Install scripts | [install/README.md](install/README.md) |
| Security policy and deployment boundary | [SECURITY.md](SECURITY.md) |
| Moonraker printers | [docs/moonraker-configuration.md](docs/moonraker-configuration.md) |
| Guided filament calibration | [docs/calibration.md](docs/calibration.md) |
| Storage locations | [docs/storage-locations.md](docs/storage-locations.md) |
| Entra ID single sign-on | [docs/authentication/entra-id.md](docs/authentication/entra-id.md) |
| Architecture decisions | [docs/decisions/](docs/decisions/) |
| Naming and compatibility policy | [docs/rebranding.md](docs/rebranding.md) |
| Upstream synchronization | [docs/upstream-sync.md](docs/upstream-sync.md) |
| Contributing and development setup | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Contributing

Report bugs and request features in [the issue tracker](https://github.com/Timpan4/layercove/issues). See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, tests, and pull request rules.

## License and attribution

LayerCove is distributed under the GNU Affero General Public License v3.0 or later; see [LICENSE](LICENSE). It is a modified fork of [Bambuddy](https://github.com/maziggy/bambuddy), whose authors and contributors keep copyright in their work. Git history, license notices, inherited code comments, and upstream links are kept for attribution. Coverage of the upstream project is collected on the [Bambuddy press page](https://bambuddy.cool/press.html).

Product and project names belong to their owners. LayerCove makes no trademark uniqueness or clearance claim.

## Acknowledgments

- [Bambuddy](https://github.com/maziggy/bambuddy) and its contributors for the inherited application
- [Klipper](https://www.klipper3d.org/) and [Moonraker](https://github.com/Arksine/moonraker) for the open printer stack
- [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) for cross-vendor slicing
- [Spoolman](https://github.com/Donkie/Spoolman) for filament inventory
- [SpoolEase](https://github.com/yanshay/SpoolEase) and the printer reverse-engineering community
