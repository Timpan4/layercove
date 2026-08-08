#!/usr/bin/env python3
"""Build the process schema from one pinned Orca source checkout.

The extraction step is intentionally explicit: it must emit the four JSON
inputs below from the pinned checkout before this exporter runs. This avoids
shipping a hand-maintained snapshot that can silently drift from Orca.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

REQUIRED = ("options.json", "layout.json", "scopes.json", "samples.json")


class SchemaError(ValueError):
    pass


def _read(root: Path, name: str) -> Any:
    path = root / name
    if not path.is_file():
        raise SchemaError(f"missing schema input: {path}")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SchemaError(f"invalid JSON in {path}: {exc.msg}") from exc


def export_schema(root: Path, *, version: str, commit: str) -> dict[str, Any]:
    options = _read(root, "options.json")
    layout = _read(root, "layout.json")
    scopes = _read(root, "scopes.json")
    samples = _read(root, "samples.json")
    if not isinstance(options, list) or not isinstance(layout, dict):
        raise SchemaError("options.json must be a list and layout.json an object")
    if not isinstance(scopes, dict) or not isinstance(samples, dict):
        raise SchemaError("scopes.json and samples.json must be objects")

    keys = [item.get("key") for item in options if isinstance(item, dict)]
    if any(not isinstance(key, str) or not key for key in keys):
        raise SchemaError("every option must have a non-empty key")
    duplicates = sorted({key for key in keys if keys.count(key) > 1})
    if duplicates:
        raise SchemaError(f"duplicate option keys: {', '.join(duplicates)}")
    option_map = {item["key"]: item for item in options}
    placed = {key for groups in layout.values() for keys in groups.values() for key in keys}
    unknown = sorted(placed - option_map.keys())
    unplaced = sorted(option_map.keys() - placed)
    if unknown:
        raise SchemaError(f"unknown placed keys: {', '.join(unknown)}")
    if unplaced:
        raise SchemaError(f"unplaced option keys: {', '.join(unplaced)}")
    missing_scope = sorted(option_map.keys() - scopes.keys())
    missing_sample = sorted(option_map.keys() - samples.keys())
    if missing_scope or missing_sample:
        missing = missing_scope + missing_sample
        raise SchemaError(f"missing scope/sample for: {', '.join(sorted(set(missing)))}")

    pages = [
        {"name": page, "groups": [{"name": group, "options": layout[page][group]} for group in groups]}
        for page, groups in layout.items()
    ]
    payload = {"pages": pages, "options": options, "scopes": scopes, "samples": samples}
    normalized = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return {
        "contract_version": "1",
        "engine": {"name": "OrcaSlicer", "version": version, "commit": commit},
        "image_identity": {"digest": "runtime-supplied"},
        "schema_hash": hashlib.sha256(normalized).hexdigest(),
        "capabilities": {"process_schema": True, "model_state": True, "progress": True, "cancel": False},
        "supported_scopes": ["global", "object"],
        **payload,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        result = export_schema(args.input_dir, version=args.version, commit=args.commit)
    except SchemaError as exc:
        parser.error(str(exc))
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
