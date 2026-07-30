#!/usr/bin/env python3
"""Write FastAPI's OpenAPI document to stdout with stable JSON formatting."""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["LOG_TO_FILE"] = "false"

from backend.app.main import app  # noqa: E402

schema = app.openapi()
for path_item in schema.get("paths", {}).values():
    for operation in path_item.values():
        if isinstance(operation, dict):
            operation.pop("operationId", None)

print(json.dumps(schema, indent=2, sort_keys=True))
