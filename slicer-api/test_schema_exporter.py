import json
import tempfile
import unittest
from pathlib import Path

from schema_exporter import SchemaError, export_schema


class ExporterTest(unittest.TestCase):
    def test_rejects_unplaced_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "options.json").write_text(json.dumps([{"key": "speed"}, {"key": "orphan"}]))
            (root / "layout.json").write_text(json.dumps({"Process": {"General": ["speed"]}}))
            (root / "scopes.json").write_text(json.dumps({"speed": "global", "orphan": "global"}))
            (root / "samples.json").write_text(json.dumps({"speed": {}, "orphan": {}}))
            with self.assertRaisesRegex(SchemaError, "unplaced"):
                export_schema(root, version="2.4.2", commit="8500fcdccaa10b5099ac20d252af3a7c560046f1")

    def test_hash_is_stable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "options.json").write_text(json.dumps([{"key": "speed", "type": "int"}]))
            (root / "layout.json").write_text(json.dumps({"Process": {"General": ["speed"]}}))
            (root / "scopes.json").write_text(json.dumps({"speed": "global"}))
            (root / "samples.json").write_text(json.dumps({"speed": {"default": 100}}))
            first = export_schema(root, version="2.4.2", commit="8500fcdccaa10b5099ac20d252af3a7c560046f1")
            second = export_schema(root, version="2.4.2", commit="8500fcdccaa10b5099ac20d252af3a7c560046f1")
            self.assertEqual(first["schema_hash"], second["schema_hash"])


if __name__ == "__main__":
    unittest.main()
