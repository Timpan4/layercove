"""Bounds on 3MF/ZIP expansion for archives we did not create."""

import copy
import zipfile

from backend.app.services.virtual_printer.ftp_server import MAX_UPLOAD_BYTES

# Total uncompressed size cap, shared with the 4 GiB upload cap.
MAX_ZIP_UNCOMPRESSED_BYTES = MAX_UPLOAD_BYTES

_CHUNK = 1024 * 1024


class ZipTooLargeError(ValueError):
    """Raised when an archive would expand past MAX_ZIP_UNCOMPRESSED_BYTES."""


def check_zip_size(zf: zipfile.ZipFile) -> None:
    """Reject the archive when its declared uncompressed total exceeds the cap."""
    total = sum(info.file_size for info in zf.infolist())
    if total > MAX_ZIP_UNCOMPRESSED_BYTES:
        raise ZipTooLargeError(f"Archive expands to {total} bytes, over the {MAX_ZIP_UNCOMPRESSED_BYTES} byte limit")


class ZipBudget:
    """Tracks bytes actually read across members of one archive."""

    def __init__(self) -> None:
        self.remaining = MAX_ZIP_UNCOMPRESSED_BYTES

    def copy_member(self, src: zipfile.ZipFile, dst: zipfile.ZipFile, info: zipfile.ZipInfo) -> None:
        """Stream one member from ``src`` into ``dst``, failing once the budget is spent.

        ``dst`` gets its own ZipInfo copy: writing mutates it, and ``src`` still
        needs the original offsets.
        """
        with src.open(info) as reader, dst.open(copy.copy(info), "w", force_zip64=True) as writer:
            while chunk := reader.read(_CHUNK):
                self.remaining -= len(chunk)
                if self.remaining < 0:
                    raise ZipTooLargeError(f"Archive expands past the {MAX_ZIP_UNCOMPRESSED_BYTES} byte limit")
                writer.write(chunk)
