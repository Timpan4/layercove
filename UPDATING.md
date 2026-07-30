# Updating LayerCove

LayerCove supports Docker Compose as its production deployment path. Take a backup first through **Settings → Backup → Create Backup** and record the image currently running.

LayerCove does not import inherited `bambutrack.db` or `bambuddy.db` databases implicitly. Export old data before starting LayerCove, or configure an explicit external `DATABASE_URL`. The default SQLite database is `layercove.db`.

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
