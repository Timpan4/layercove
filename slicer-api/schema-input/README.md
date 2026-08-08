# Schema extraction inputs

This directory is intentionally empty in this checkout. Before building the
custom image, run an extractor against the exact OrcaSlicer checkout pinned in
`../build-metadata.json` and write these files here:

- `options.json`: one object per process key with type, label, tooltip, mode,
  units, bounds, enum choices, and default metadata from `PrintConfig.cpp`.
- `layout.json`: ordered `page -> group -> [key]` output from
  `TabPrint::build`; put the three explicitly approved non-process options in
  page-local `Other` groups.
- `scopes.json`: `key -> global|object` applicability from GUI object-option
  declarations.
- `samples.json`: `key -> defaults/relevance` extracted from process profile
  JSON files.

`schema_exporter.py` rejects missing, duplicate, unknown, unplaced, or
incomplete keys. Do not replace these inputs with a static hand-maintained
schema.
