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
schemas = schema["components"]["schemas"]


def referenced_schemas(nodes: list) -> set[str]:
    """Collect the components referenced directly or through another schema."""
    found: set[str] = set()
    remaining = nodes.copy()
    while remaining:
        node = remaining.pop()
        if isinstance(node, dict):
            ref = node.get("$ref", "")
            if ref.startswith("#/components/schemas/"):
                name = ref.removeprefix("#/components/schemas/")
                if name in schemas and name not in found:
                    found.add(name)
                    remaining.append(schemas[name])
            remaining.extend(node.values())
        elif isinstance(node, list):
            remaining.extend(node)
    return found


request_bodies = []
other_uses = []
for path_item in schema.get("paths", {}).values():
    for operation in path_item.values():
        if isinstance(operation, dict):
            operation.pop("operationId", None)
            request_bodies.append(operation.get("requestBody"))
            other_uses.extend(value for key, value in operation.items() if key != "requestBody")
        else:
            other_uses.append(operation)

# openapi-typescript uses defaults to make response properties required.
# Request-only properties are optional when the server supplies a default.
for name in referenced_schemas(request_bodies) - referenced_schemas(other_uses):
    component = schemas[name]
    required = set(component.get("required", []))
    for key, prop in component.get("properties", {}).items():
        if key not in required and prop.get("default") is not None:
            prop.pop("default")

print(json.dumps(schema, indent=2, sort_keys=True))
