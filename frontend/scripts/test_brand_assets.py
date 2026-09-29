#!/usr/bin/env python3
"""Validate LayerCove brand assets without third-party dependencies."""
from __future__ import annotations
import json
import re
import struct
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[1]
PUBLIC = FRONTEND / "public"
IMAGE = PUBLIC / "img"
STATIC = FRONTEND.parent / "static"
SVG_NAMES = (
    "layercove-mark.svg", "layercove-mark-light.svg", "layercove-mark-dark.svg",
    "layercove-wordmark.svg", "layercove-wordmark-light.svg", "layercove-wordmark-dark.svg",
)
EXPECTED_PNGS = {
    "favicon-16x16.png": (16, 16), "favicon-32x32.png": (32, 32),
    "apple-touch-icon.png": (180, 180), "layercove-icon-192.png": (192, 192),
    "layercove-icon-512.png": (512, 512), "layercove-icon-maskable-192.png": (192, 192),
    "layercove-icon-maskable-512.png": (512, 512),
}

def png_rgba(path: Path) -> tuple[int, int, bytes]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise AssertionError(f"{path.name} is not a PNG with an IHDR chunk")
    width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(">IIBBBBB", data[16:29])
    if (bit_depth, color_type, compression, filter_method, interlace) != (8, 6, 0, 0, 0):
        raise AssertionError(f"{path.name} is not an 8-bit RGBA PNG")
    offset, compressed = 8, bytearray()
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        if data[offset + 4 : offset + 8] == b"IDAT":
            compressed.extend(data[offset + 8 : offset + 8 + length])
        offset += 12 + length
    rows, stride = zlib.decompress(compressed), 1 + width * 4
    if len(rows) != height * stride or any(rows[row * stride] for row in range(height)):
        raise AssertionError(f"{path.name} has unsupported PNG scanline filters")
    return width, height, b"".join(rows[row * stride + 1 : (row + 1) * stride] for row in range(height))

def png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise AssertionError(f"{path.name} is not a PNG with an IHDR chunk")
    return struct.unpack(">II", data[16:24])

class BrandAssetsTest(unittest.TestCase):
    def test_svg_metadata_paths_and_monochrome_support(self) -> None:
        namespace = {"svg": "http://www.w3.org/2000/svg"}
        for name in SVG_NAMES:
            root = ET.parse(IMAGE / name).getroot()
            self.assertEqual(root.attrib.get("role"), "img")
            self.assertTrue(root.findall("svg:title", namespace), name)
            self.assertTrue(root.findall("svg:desc", namespace), name)
            self.assertTrue(root.findall("svg:path", namespace) or root.findall(".//svg:path", namespace), name)
            source = (IMAGE / name).read_text(encoding="utf-8")
            for forbidden in ("<text", "<image", "font-", "font-family", "@import"):
                self.assertNotIn(forbidden, source, name)
            self.assertIn("currentColor", source, name)

    def test_png_types_and_dimensions(self) -> None:
        for name, expected_dimensions in EXPECTED_PNGS.items():
            with self.subTest(name=name):
                self.assertEqual(png_dimensions(IMAGE / name), expected_dimensions)

    def test_png_generator_reproduces_checked_in_icons(self) -> None:
        generator = FRONTEND / "scripts" / "generate-brand-assets.py"
        with tempfile.TemporaryDirectory() as directory:
            generated = Path(directory)
            source = generator.read_text(encoding="utf-8").replace(
                'OUTPUT = Path(__file__).resolve().parents[1] / "public" / "img"',
                f"OUTPUT = Path({str(generated)!r})",
            )
            isolated_generator = generated / generator.name
            isolated_generator.write_text(source, encoding="utf-8")
            subprocess.run([sys.executable, str(isolated_generator)], check=True)
            for name in {*EXPECTED_PNGS, "favicon.png"}:
                with self.subTest(name=name):
                    self.assertEqual((generated / name).read_bytes(), (IMAGE / name).read_bytes())

    def test_manifest_assets_exist_and_match_declared_dimensions(self) -> None:
        manifest = json.loads((PUBLIC / "manifest.json").read_text(encoding="utf-8"))
        assets = [*manifest["icons"], *manifest.get("screenshots", [])]
        assets.extend(icon for shortcut in manifest.get("shortcuts", []) for icon in shortcut.get("icons", []))
        maskable_sources = set()
        for asset in assets:
            with self.subTest(src=asset["src"]):
                self.assertEqual(asset["type"], "image/png")
                path = PUBLIC / asset["src"].lstrip("/")
                self.assertTrue(path.is_file(), asset["src"])
                self.assertEqual(png_dimensions(path), tuple(map(int, asset["sizes"].split("x"))))
                if asset.get("purpose") == "maskable":
                    maskable_sources.add(asset["src"])
        self.assertEqual(maskable_sources, {"/img/layercove-icon-maskable-192.png", "/img/layercove-icon-maskable-512.png"})

    def test_maskable_marks_stay_within_the_safe_area(self) -> None:
        background = bytes((13, 36, 48, 255))
        for name in ("layercove-icon-maskable-192.png", "layercove-icon-maskable-512.png"):
            width, height, pixels = png_rgba(IMAGE / name)
            mark_pixels = [(index % width, index // width) for index in range(width * height) if pixels[index * 4 : index * 4 + 4] != background]
            self.assertTrue(mark_pixels, name)
            safe_margin = width * 0.10
            self.assertGreaterEqual(min(x for x, _ in mark_pixels), safe_margin, name)
            self.assertLess(max(x for x, _ in mark_pixels), width - safe_margin, name)
            self.assertGreaterEqual(min(y for _, y in mark_pixels), safe_margin, name)
            self.assertLess(max(y for _, y in mark_pixels), height - safe_margin, name)

    def test_no_inherited_bambuddy_logo_is_rendered(self) -> None:
        for path in (FRONTEND / "src").rglob("*.tsx"):
            self.assertNotIn("bambuddy_logo", path.read_text(encoding="utf-8"), path)

    def test_collapsed_sidebar_uses_theme_specific_compact_marks(self) -> None:
        layout = (FRONTEND / "src" / "components" / "Layout.tsx").read_text(encoding="utf-8")
        self.assertIn("? '/img/layercove-mark-light.svg'", layout)
        self.assertIn(": '/img/layercove-mark-dark.svg'", layout)
        self.assertIn('color="#f8fafc"', (IMAGE / "layercove-mark-light.svg").read_text(encoding="utf-8"))
        self.assertIn('color="#0d2430"', (IMAGE / "layercove-mark-dark.svg").read_text(encoding="utf-8"))

    def test_auth_pages_use_the_resolved_theme(self) -> None:
        for name in ("LoginPage.tsx", "SetupPage.tsx"):
            source = (FRONTEND / "src" / "pages" / name).read_text(encoding="utf-8")
            self.assertIn("const { resolvedMode } = useTheme();", source, name)
            self.assertIn("resolvedMode === 'dark'", source, name)

    def test_built_brand_assets_match_public_sources(self) -> None:
        expected = {
            "manifest.json",
            "sw.js",
            *(f"img/{name}" for name in SVG_NAMES),
            *(f"img/{name}" for name in EXPECTED_PNGS),
            "img/favicon.png",
        }
        for relative in expected:
            with self.subTest(path=relative):
                source = PUBLIC / relative
                built = STATIC / relative
                self.assertTrue(built.is_file(), relative)
                self.assertEqual(built.read_bytes(), source.read_bytes(), relative)

        source_index = (FRONTEND / "index.html").read_text(encoding="utf-8")
        built_index = (STATIC / "index.html").read_text(encoding="utf-8")
        for path in re.findall(r'(?:href|src)="(/[^"]+)"', source_index):
            if path != "/src/main.tsx":
                self.assertIn(f'"{path}"', built_index, path)
        for path in re.findall(r'(?:href|src)="(/(?:assets|img)/[^"]+)"', built_index):
            self.assertTrue((STATIC / path.lstrip("/")).is_file(), path)

        bundle = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (STATIC / "assets").glob("*.js")
        )
        rendered = set()
        for path in (FRONTEND / "src").rglob("*.tsx"):
            rendered.update(
                f"/img/{name}"
                for name in re.findall(
                    r"/img/(layercove-[^'\"]+\.svg)",
                    path.read_text(encoding="utf-8"),
                )
            )
        for source in rendered:
            self.assertIn(source, bundle, source)

    def test_rendered_brand_assets_are_precached(self) -> None:
        sources = set()
        for path in (FRONTEND / "src").rglob("*.tsx"):
            source = path.read_text(encoding="utf-8")
            sources.update(f"/img/{name}" for name in re.findall(r"/img/(layercove-[^'\"]+\.svg)", source))
        service_worker = (PUBLIC / "sw.js").read_text(encoding="utf-8")
        for source in sources:
            self.assertIn(f"'{source}'", service_worker, source)

if __name__ == "__main__":
    unittest.main()
