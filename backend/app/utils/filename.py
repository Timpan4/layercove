"""Print-file filename validation matching Bambu Studio's save-dialog rules.

The Bambu printer SD card is FAT32/exFAT. Names containing the Windows /
DOS-reserved set (``< > : " / \\ | ? *``), ASCII control characters
(0x00-0x1F), or trailing dots / spaces cannot be created on it — FTP fails
with ``553 Could not create file`` (#1540). Bambu Studio refuses to save
such names client-side; Bambuddy now does the same at the rename, upload,
and dispatch boundaries so the failure surfaces with a clear message
instead of an obscure FTP error after the user has already hit Print.
"""

INVALID_FILENAME_CHARS = '<>:"/\\|?*'

# FAT/exFAT cap on a single path component; UTF-8 byte length, not codepoints,
# because that is what the on-disk encoding limit actually is.
MAX_FILENAME_BYTES = 255


class InvalidFilenameError(ValueError):
    """Filename contains characters or shape the printer SD card rejects.

    ``char`` is the first offending character when the failure is a
    character-set violation, or ``None`` for structural failures (empty,
    bare ``.``, trailing space, too long, etc.). The frontend echoes it
    back to the user in the Bambu Studio-style error message.
    """

    def __init__(self, message: str, char: str | None = None):
        super().__init__(message)
        self.char = char


def validate_print_filename(name: str) -> None:
    """Raise ``InvalidFilenameError`` if ``name`` would fail on the SD card.

    Matches Bambu Studio's save-dialog rejection set. Callers are expected
    to translate the exception into an HTTP 400 (or a clean dispatch
    rejection); the message is intentionally short and ASCII so it fits
    a translation template.
    """
    if not name or not name.strip():
        raise InvalidFilenameError("Filename cannot be empty")

    if name in (".", ".."):
        raise InvalidFilenameError("Filename cannot be '.' or '..'")

    for ch in name:
        if ch in INVALID_FILENAME_CHARS:
            raise InvalidFilenameError(f"Filename contains invalid character: {ch}", char=ch)
        if ord(ch) < 0x20:
            raise InvalidFilenameError("Filename contains a control character", char=ch)

    if name.endswith(" ") or name.endswith("."):
        raise InvalidFilenameError("Filename cannot end with a space or dot")

    if len(name.encode("utf-8")) > MAX_FILENAME_BYTES:
        raise InvalidFilenameError(f"Filename exceeds {MAX_FILENAME_BYTES} bytes")


def validate_moonraker_gcode_basename(name: str) -> None:
    """Reject anything except one safe ``.gcode`` filename for Moonraker."""
    if not isinstance(name, str) or name != name.rsplit("/", 1)[-1] or "\\" in name:
        raise InvalidFilenameError("Moonraker upload requires a single filename")
    validate_print_filename(name)
    if not name.lower().endswith(".gcode"):
        raise InvalidFilenameError("Moonraker upload requires a .gcode file")


def derive_remote_filename(filename: str) -> str:
    """Compute the SD-card filename used when uploading a sliced print file.

    Strips repeated trailing ``.gcode.3mf`` / ``.3mf`` suffixes until the
    bare stem remains, then appends a single ``.3mf``; spaces are
    replaced with underscores because the firmware parses
    ``ftp://{filename}`` as a URL.

    Canonical for both the dispatch uploader and the post-print SD
    cleanup — when the two drift apart the cleanup misses, and a
    library row whose stored filename ended up with a doubled
    ``.gcode.3mf`` (#1542) leaves the real file on the SD card. On A1
    firmware that lingering file becomes a ghost print on the next
    power-on (same family as the P1S behaviour in #374).

    Raises ``TypeError`` on non-string input rather than entering the
    strip loop, because a duck-typed object that returns truthy
    sentinels from ``endswith`` would never escape and the resulting
    unbounded allocation has cgroup-OOM'd the test runner under mocks.
    """
    if not isinstance(filename, str):
        raise TypeError(f"derive_remote_filename requires str, got {type(filename).__name__}")
    stem = filename
    while True:
        if stem.endswith(".gcode.3mf"):
            stem = stem[:-10]
        elif stem.endswith(".3mf"):
            stem = stem[:-4]
        else:
            break
    return f"{stem}.3mf".replace(" ", "_")


def derive_moonraker_upload_filename(filename: str) -> str:
    """Preserve the visible export basename; dispatch uniqueness lives in a directory.

    Legacy 3MF names are converted to .gcode after validated plate extraction.
    Only unsafe legacy characters and path prefixes are normalized.
    """
    if not isinstance(filename, str):
        raise TypeError("Moonraker source filename must be a string")
    stem = filename.replace("\\", "/").rsplit("/", 1)[-1]
    while suffix := next((value for value in (".gcode.3mf", ".3mf", ".gcode") if stem.lower().endswith(value)), None):
        stem = stem[: -len(suffix)]
    stem = (
        "".join("_" if char in INVALID_FILENAME_CHARS or not char.isprintable() else char for char in stem).strip(" ._")
        or "print"
    )
    stem = stem.encode("utf-8")[: MAX_FILENAME_BYTES - len(".gcode")].decode("utf-8", errors="ignore").rstrip(" ._")
    result = f"{stem}.gcode"
    validate_moonraker_gcode_basename(result)
    return result


def validate_moonraker_upload_directory(directory: str) -> None:
    """Validate a literal path relative to the gcodes root, without normalizing it."""
    if not isinstance(directory, str) or not directory or len(directory.encode("utf-8")) > 1024:
        raise InvalidFilenameError("Moonraker upload directory must be a bounded relative path")
    for part in directory.split("/"):
        validate_print_filename(part)
        if any(not char.isprintable() for char in part):
            raise InvalidFilenameError("Moonraker upload directory contains a control character")
