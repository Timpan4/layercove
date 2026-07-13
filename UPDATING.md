# Updating LayerCove

Choose the section that matches the current installation. Take a backup first: **Settings → Backup → Create Backup** downloads the database and stateful files. Native `install/update.sh` also calls the backup API before changing code unless `BACKUP_MODE=skip` is set.

Compatibility identifiers are intentional. The Compose service/container remains `bambuddy`, the named volumes remain `bambuddy_data` and `bambuddy_logs`, the native service remains `bambuddy`, and the default SQLite filename remains `bambuddy.db`. Do not rename them during an upgrade.

## Existing Docker deployment

1. Record the image currently running so it can be used for rollback:

   ```bash
   docker compose images
   docker compose config > compose.before.yml
   ```

2. Download the LayerCove Compose file beside the existing one and review it. Do not replace the file until the diff shows the same service and volume names and any local ports, bind mounts, environment values, or database settings have been carried forward.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Timpan4/layercove/main/docker-compose.yml \
     -o docker-compose.yml.layercove
   diff -u docker-compose.yml docker-compose.yml.layercove
   docker compose -f docker-compose.yml.layercove config >/dev/null
   ```

3. Merge the reviewed changes into `docker-compose.yml`, then pull and recreate without `down -v`:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps
   curl --fail http://localhost:8000/health
   ```

The LayerCove image is `ghcr.io/timpan4/layercove:latest`. Pin a release tag or digest for reproducible production updates. The first LayerCove start runs database migrations in place; no Alembic command is required.

### Docker rollback

Set the `image:` line to the previously recorded tag or digest, then recreate the application container:

```bash
docker compose pull
docker compose up -d
```

Do not run `docker compose down -v`: `-v` deletes the named data volumes. If a migration makes the prior image incompatible, restore the backup before starting it and record the failure as an issue.

## Fresh Docker deployment

```bash
mkdir layercove && cd layercove
curl -fsSLO https://raw.githubusercontent.com/Timpan4/layercove/main/docker-compose.yml
docker compose config
docker compose pull
docker compose up -d
```

Linux host networking enables printer discovery. Docker Desktop users must comment `network_mode: host`, enable the documented port mapping, and add printers manually by address. The platform installers in [`install/`](install/) automate this setup.

## Native Git installation

Run the updater already stored in the installation. It derives the install root from its own location, so both existing `/opt/bambuddy` installs and fresh `/opt/layercove` installs work:

```bash
sudo /path/to/install/install/update.sh
```

The updater records the current commit, creates a backup, stops the compatible `bambuddy` service, resets the checkout to its configured `origin/main`, updates Python dependencies, rebuilds the frontend, and restarts the service. It attempts to reset to the recorded commit and restart the service if a later step fails.

Before switching an existing Bambuddy checkout to LayerCove, verify and replace only its Git remote; leave the install path, data directories, service, and environment file in place:

```bash
cd /opt/bambuddy
git remote -v
git remote set-url origin https://github.com/Timpan4/layercove.git
git fetch origin
sudo install/update.sh
```

These are operator commands for a deployed clone, not development commands for a GitButler workspace.

### Native rollback

The updater prints the old and new commit IDs. To roll back after an application-level failure:

```bash
cd /path/to/install
sudo systemctl stop bambuddy
sudo -u bambuddy git reset --hard OLD_COMMIT
sudo -u bambuddy venv/bin/pip install -r requirements.txt
sudo systemctl start bambuddy
```

Restore the pre-upgrade backup if the database migration cannot run on the old revision. macOS installations use `install/update_macos.sh` and the retained `com.bambuddy.app` launchd label.

## ZIP or tarball installation

Archive downloads have no `.git` metadata and cannot use the native updater. Back up the stateful directories, install LayerCove into a new directory, stop both services, restore the backup into the new data directory, and start only the new installation. Do not delete the old tree until the health endpoint and printer list are verified.

## Post-update checks

- Open `/health` and the frontend.
- Confirm existing Bambu and Moonraker printers, queue/history, archive, and Spoolman settings are present.
- Verify no credentials were copied into logs or support output.
- Keep the previous image/revision and backup until a representative upload/dispatch workflow succeeds.

For source-maintainer synchronization with upstream Bambuddy, use [`docs/upstream-sync.md`](docs/upstream-sync.md); do not apply deployment update commands to `gitbutler/workspace`.
