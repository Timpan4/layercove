# Updating LayerCove

LayerCove supports Docker Compose as its production deployment path. Take a backup first through **Settings → Backup → Create Backup** and record the image currently running.

LayerCove does not open Bambuddy or BambuTrack databases implicitly. If `bambuddy.db` or `bambutrack.db` is in the data directory and `DATABASE_URL` is unset, LayerCove refuses to start. Export the old data and move the file out, or set `DATABASE_URL` to a new database. Backup restore also rejects archives that contain either file. The default SQLite database is `layercove.db`.

LayerCove starts only from its current schema and has no historical migration chain. Keep the pre-update backup until the new version is confirmed working; restoring it is the rollback path.

## Existing LayerCove deployment

1. Record the current image and resolved configuration:

   ```bash
   docker compose images
   docker compose config > compose.before.yml
   ```

2. Download the current Compose file beside the existing one and review local ports, mounts, and environment values before replacing anything:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Timpan4/layercove/main/docker-compose.yml \
     -o docker-compose.yml.next
   diff -u docker-compose.yml docker-compose.yml.next
   docker compose -f docker-compose.yml.next config >/dev/null
   ```

3. Merge the reviewed changes, then pull and recreate without deleting volumes:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps
   curl --fail http://localhost:8000/health
   ```

Pin a release tag or digest instead of `latest` when reproducible production updates are required.

## Optional bundled Spoolman

The bundled service is opt-in and does not change existing external Spoolman settings. It uses the pinned `ghcr.io/donkie/spoolman:0.21.0` image and the durable `spoolman_data` named volume. It has no `depends_on` relationship with LayerCove, so stopping, restoring, or upgrading it does not block LayerCove startup or normal printer operation.

Enable it only when wanted:

```bash
docker compose --profile spoolman pull
docker compose --profile spoolman up -d
docker compose --profile spoolman ps
```

It publishes `127.0.0.1:7912` only, so it is not reachable from the LAN or Internet. After `docker compose --profile spoolman ps` reports healthy, open **Settings → Filament → Filament Tracking**, choose Spoolman, and set **Spoolman URL** to `http://127.0.0.1:7912` on Linux when LayerCove uses the default host networking. On Docker Desktop, where the Compose instructions require bridge networking, use the private Compose service address `http://spoolman:8000` instead. Spoolman itself has no built-in authentication; retain the loopback binding, or put it behind an authenticated reverse proxy if deliberately exposing it. Do not change an existing external URL unless migrating its data separately.

### Spoolman backup, restore, upgrade, and rollback

Download the volume helper beside `docker-compose.yml` before the first backup or restore, and refresh it whenever you update the Compose file:

```bash
mkdir -p scripts
curl -fsSL https://raw.githubusercontent.com/Timpan4/layercove/main/scripts/spoolman_volume.py \
  -o scripts/spoolman_volume.py
```

Back up while the service is stopped so the SQLite database is consistent. Backup runs as the invoking host UID with Spoolman's service GID, which lets it write the host archive and publish it group-readable as `0640`; restore runs as Spoolman's default service UID/GID so it can read that archive and keep restored files writable when the normal entrypoint starts the server. The archive contains only Spoolman data; it does not touch `layercove_data`, `layercove_logs`, or an external Spoolman instance.

```bash
# Backup
docker compose --profile spoolman stop spoolman
docker compose --profile spoolman run --rm --no-deps --user "$(id -u):1000" --entrypoint python \
  -v "$PWD:/backup" -v "$PWD/scripts:/layercove-scripts:ro" spoolman \
  /layercove-scripts/spoolman_volume.py backup \
  /home/app/.local/share/spoolman /backup/spoolman-data-backup.tgz
docker compose --profile spoolman up -d spoolman

# Restore (validates and stages the archive before replacing live data)
docker compose --profile spoolman stop spoolman
docker compose --profile spoolman run --rm --no-deps --user 1000:1000 --entrypoint python \
  -v "$PWD:/backup:ro" -v "$PWD/scripts:/layercove-scripts:ro" spoolman \
  /layercove-scripts/spoolman_volume.py restore \
  /home/app/.local/share/spoolman /backup/spoolman-data-backup.tgz && \
  docker compose --profile spoolman up -d spoolman
```

If restore fails, leave Spoolman stopped and read the error before retrying. A message naming `.layercove-restore-rollback` means automatic rollback also failed but the complete pre-restore snapshot remains in that directory; repair the volume or copy that snapshot out before running another restore or starting Spoolman.

Before an upgrade, make that backup and record the current image with `docker compose --profile spoolman images spoolman`. Change only the pinned `spoolman` image tag after reviewing the [Spoolman release notes](https://github.com/Donkie/Spoolman/releases), then run `docker compose --profile spoolman pull spoolman && docker compose --profile spoolman up -d spoolman`. If a schema migration makes the previous image incompatible, restore the pre-upgrade archive first, set the recorded image tag, and recreate the `spoolman` service. Never use `docker compose down -v`; it deletes named volumes.

## Fresh deployment

```bash
mkdir layercove && cd layercove
curl -fsSLO https://raw.githubusercontent.com/Timpan4/layercove/main/docker-compose.yml
docker compose config
docker compose pull
docker compose up -d
```

Linux host networking enables printer discovery. Docker Desktop users must comment `network_mode: host`, enable the documented port mapping, and add printers manually by address. The scripts under [`install/`](install/) automate this setup.

## Rollback

Set the `image:` line to the previously recorded LayerCove tag or digest, restore the matching backup when schema compatibility requires it, and recreate the container:

```bash
docker compose pull
docker compose up -d
```

Never run `docker compose down -v`: `-v` deletes the named data volumes.

## Post-update checks

- Open `/health` and the frontend.
- Confirm printers, queue/history, archive, and inventory settings are present.
- Verify no credentials were copied into logs or support output.
- Keep the previous image reference and backup until a representative upload and dispatch succeeds.

For source-maintainer synchronization with upstream Bambuddy, use [`docs/upstream-sync.md`](docs/upstream-sync.md). Those development instructions are not deployment update commands.
