# Slicer API sidecar

LayerCove's production sidecar is built from OrcaSlicer **2.4.2** at commit
`8500fcdccaa10b5099ac20d252af3a7c560046f1`. `build-metadata.json` is the source
of truth. The image must be referenced by a verified digest; this repository
intentionally does not invent one.

## Build contract

`Dockerfile.orca` runs `schema_exporter.py` during the image build. The
exporter consumes extraction output from the same pinned checkout:

- `src/libslic3r/PrintConfig.cpp`
- `src/slic3r/GUI/Tab.cpp` (`TabPrint::build`)
- Orca GUI object-option declarations (for example `GUI_Factories.cpp`)
- `resources/profiles/**/process/*.json`

The required normalized files are documented in `schema-input/README.md`.
Missing, duplicate, unknown, unplaced, or incomplete keys fail the build. This
is scaffolding until the upstream extraction stage is available; it does not
ship a fake static schema or claim reproducible CLI output.

## Compose

Copy `.env.example`, replace both `REPLACE_WITH_VERIFIED_DIGEST` values, then:

```bash
docker compose up -d
```

Services use an internal Docker network and publish no host ports. Attach the
LayerCove service to `slicer-api_slicer` (or add an explicit authenticated TLS
proxy) for access. Cross-host use requires authenticated TLS; never expose the
sidecar directly.

The Orca health check verifies liveness and the pinned commit in
`/capabilities`; the sidecar contract must also include contract version,
image identity, schema hash, capabilities, pages/groups/options, and supported
scopes. Cancel is not advertised until the worker can actually stop a job.

## Upgrades

1. Choose a new Orca version and commit.
2. Regenerate all schema inputs from that exact checkout.
3. Build twice and compare normalized `schema.json` and `schema_hash`.
4. Verify capabilities, override/model-state rejection, progress, and a real
   representative slice before publishing a new digest.
5. Update `build-metadata.json`, expected commit, and the deployment digest
   together. Keep the previous digest for rollback.
