#!/usr/bin/env python3
"""Generate LayerCove PNG application icons from the original layer-mark geometry."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUTPUT = Path(__file__).resolve().parents[1] / "public" / "img"
BACKGROUND = (13, 36, 48, 255)
MARK = (148, 227, 188, 255)


def distance_to_segment(px: float, py: float, start: tuple[float, float], end: tuple[float, float]) -> float:
    sx, sy = start
    ex, ey = end
    dx, dy = ex - sx, ey - sy
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5
    projection = max(0, min(1, ((px - sx) * dx + (py - sy) * dy) / length_squared))
    nearest_x, nearest_y = sx + projection * dx, sy + projection * dy
    return ((px - nearest_x) ** 2 + (py - nearest_y) ** 2) ** 0.5


def render_icon(size: int, inset: float) -> bytes:
    """Render a safe-area-friendly icon with four-sample antialiasing."""
    scale = size * inset / 64
    offset = (size - 64 * scale) / 2
    stroke = 6 * scale
    segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for y in (18, 30, 42):
        points = [(13, y), (43, y), (51, y + 8), (43, y + 16), (21, y + 16), (13, y + 8), (21, y)]
        points = [(offset + x * scale, offset + point_y * scale) for x, point_y in points]
        segments.extend(zip(points, points[1:] + points[:1]))

    pixels = bytearray()
    samples = ((0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75))
    for y in range(size):
        for x in range(size):
            coverage = sum(
                min(1, max(0, stroke / 2 + 0.5 - min(distance_to_segment(x + sx, y + sy, start, end) for start, end in segments)))
                for sx, sy in samples
            ) / len(samples)
            pixels.extend(round(BACKGROUND[channel] * (1 - coverage) + MARK[channel] * coverage) for channel in range(4))
    return bytes(pixels)


def png(size: int, inset: float) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    pixels = render_icon(size, inset)
    rows = b"".join(b"\0" + pixels[row * size * 4 : (row + 1) * size * 4] for row in range(size))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def main() -> None:
    for filename, size, inset in (
        ("favicon-16x16.png", 16, 1),
        ("favicon-32x32.png", 32, 1),
        ("favicon.png", 64, 1),
        ("apple-touch-icon.png", 180, 0.82),
        ("layercove-icon-192.png", 192, 0.82),
        ("layercove-icon-512.png", 512, 0.82),
        ("layercove-icon-maskable-192.png", 192, 0.70),
        ("layercove-icon-maskable-512.png", 512, 0.70),
    ):
        (OUTPUT / filename).write_bytes(png(size, inset))


if __name__ == "__main__":
    main()
