from __future__ import annotations

import shutil
import stat
import tarfile
from pathlib import Path

import pytest

from scripts.spoolman_volume import ROLLBACK_MARKER, ROLLBACK_NAME, STAGING_NAME, backup, restore


@pytest.mark.unit
def test_backup_and_restore_replace_only_spoolman_data(tmp_path: Path):
    data = tmp_path / "spoolman"
    data.mkdir()
    (data / "spoolman.db").write_text("before", encoding="utf-8")
    archive = tmp_path / "backup.tgz"

    backup(data, archive)
    (data / "spoolman.db").write_text("after", encoding="utf-8")
    (data / "new-file").write_text("remove me", encoding="utf-8")

    restore(data, archive)

    assert (data / "spoolman.db").read_text(encoding="utf-8") == "before"
    assert not (data / "new-file").exists()


@pytest.mark.unit
def test_backup_archive_is_readable_by_the_spoolman_group(tmp_path: Path):
    data = tmp_path / "spoolman"
    data.mkdir()
    (data / "spoolman.db").write_text("live", encoding="utf-8")
    archive = tmp_path / "backup.tgz"

    backup(data, archive)

    assert stat.S_IMODE(archive.stat().st_mode) == 0o640


@pytest.mark.unit
def test_restore_rejects_link_archive_before_touching_live_data(tmp_path: Path):
    data = tmp_path / "spoolman"
    data.mkdir()
    database = data / "spoolman.db"
    database.write_text("live", encoding="utf-8")
    archive = tmp_path / "linked.tgz"
    with tarfile.open(archive, "w:gz") as output:
        link = tarfile.TarInfo("loop")
        link.type = tarfile.SYMTYPE
        link.linkname = "."
        output.addfile(link)

    with pytest.raises(tarfile.ExtractError, match="unsupported entry"):
        restore(data, archive)

    assert database.read_text(encoding="utf-8") == "live"


@pytest.mark.unit
def test_failed_backup_preserves_existing_archive(tmp_path: Path, monkeypatch):
    data = tmp_path / "spoolman"
    data.mkdir()
    (data / "spoolman.db").write_text("live", encoding="utf-8")
    archive = tmp_path / "backup.tgz"
    archive.write_bytes(b"known-good-backup")

    def fail_add(*args, **kwargs):
        raise OSError("simulated backup failure")

    monkeypatch.setattr(tarfile.TarFile, "add", fail_add)

    with pytest.raises(OSError, match="simulated backup failure"):
        backup(data, archive)

    assert archive.read_bytes() == b"known-good-backup"
    assert not list(tmp_path.glob(f".{archive.name}.*.tmp"))


@pytest.mark.unit
def test_interrupted_rollback_cleanup_cannot_trigger_partial_recovery(tmp_path: Path, monkeypatch):
    data = tmp_path / "spoolman"
    data.mkdir()
    (data / "spoolman.db").write_text("live", encoding="utf-8")
    (data / "preferences.json").write_text("live settings", encoding="utf-8")
    replacement = tmp_path / "replacement"
    replacement.mkdir()
    (replacement / "spoolman.db").write_text("restored", encoding="utf-8")
    archive = tmp_path / "replacement.tgz"
    with tarfile.open(archive, "w:gz") as output:
        output.add(replacement / "spoolman.db", arcname="spoolman.db")

    original_rmtree = shutil.rmtree
    interrupted = False

    def interrupt_rollback_cleanup(path, *args, **kwargs):
        nonlocal interrupted
        path = Path(path)
        if path.name == ROLLBACK_NAME and not interrupted:
            interrupted = True
            (path / "preferences.json").unlink()
            raise OSError("simulated cleanup interruption")
        return original_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", interrupt_rollback_cleanup)

    with pytest.raises(OSError, match="simulated cleanup interruption"):
        restore(data, archive)

    rollback = data / ROLLBACK_NAME
    assert not (rollback / ROLLBACK_MARKER).exists()
    assert (data / "spoolman.db").read_text(encoding="utf-8") == "restored"

    restore(data, archive)

    assert (data / "spoolman.db").read_text(encoding="utf-8") == "restored"
    assert not rollback.exists()


@pytest.mark.unit
def test_restore_rejects_invalid_archive_before_touching_live_data(tmp_path: Path):
    data = tmp_path / "spoolman"
    data.mkdir()
    database = data / "spoolman.db"
    database.write_text("live", encoding="utf-8")
    archive = tmp_path / "broken.tgz"
    archive.write_text("not an archive", encoding="utf-8")

    with pytest.raises(tarfile.ReadError):
        restore(data, archive)

    assert database.read_text(encoding="utf-8") == "live"


@pytest.mark.unit
def test_restore_rejects_missing_archive_before_touching_live_data(tmp_path: Path):
    data = tmp_path / "spoolman"
    data.mkdir()
    database = data / "spoolman.db"
    database.write_text("live", encoding="utf-8")

    with pytest.raises(SystemExit, match="backup does not exist"):
        restore(data, tmp_path / "missing.tgz")

    assert database.read_text(encoding="utf-8") == "live"


@pytest.mark.unit
def test_restore_recovers_completed_snapshot_from_interrupted_attempt(tmp_path: Path):
    data = tmp_path / "spoolman"
    data.mkdir()
    (data / "partial.db").write_text("partial", encoding="utf-8")
    rollback = data / ROLLBACK_NAME
    rollback.mkdir()
    (rollback / "spoolman.db").write_text("live", encoding="utf-8")
    (rollback / ROLLBACK_MARKER).touch()
    (data / STAGING_NAME).mkdir()

    replacement = tmp_path / "replacement"
    replacement.mkdir()
    (replacement / "spoolman.db").write_text("restored", encoding="utf-8")
    archive = tmp_path / "replacement.tgz"
    with tarfile.open(archive, "w:gz") as output:
        output.add(replacement / "spoolman.db", arcname="spoolman.db")

    restore(data, archive)

    assert (data / "spoolman.db").read_text(encoding="utf-8") == "restored"
    assert not (data / "partial.db").exists()
    assert not (data / ROLLBACK_NAME).exists()
    assert not (data / STAGING_NAME).exists()


@pytest.mark.unit
def test_restore_rolls_back_when_replacement_copy_fails(tmp_path: Path, monkeypatch):
    data = tmp_path / "spoolman"
    data.mkdir()
    database = data / "spoolman.db"
    database.write_text("live", encoding="utf-8")
    replacement = tmp_path / "replacement"
    replacement.mkdir()
    (replacement / "spoolman.db").write_text("restored", encoding="utf-8")
    archive = tmp_path / "replacement.tgz"
    with tarfile.open(archive, "w:gz") as output:
        output.add(replacement / "spoolman.db", arcname="spoolman.db")

    original_copy2 = shutil.copy2

    def fail_staging_copy(source, destination, *args, **kwargs):
        if STAGING_NAME in str(source):
            raise OSError("simulated copy failure")
        return original_copy2(source, destination, *args, **kwargs)

    monkeypatch.setattr(shutil, "copy2", fail_staging_copy)

    with pytest.raises(OSError, match="simulated copy failure"):
        restore(data, archive)

    assert database.read_text(encoding="utf-8") == "live"
    assert not (data / ROLLBACK_NAME).exists()
    assert not (data / STAGING_NAME).exists()


@pytest.mark.unit
def test_restore_retains_snapshot_when_automatic_rollback_fails(tmp_path: Path, monkeypatch):
    data = tmp_path / "spoolman"
    data.mkdir()
    database = data / "spoolman.db"
    database.write_text("live", encoding="utf-8")
    replacement = tmp_path / "replacement"
    replacement.mkdir()
    (replacement / "spoolman.db").write_text("restored", encoding="utf-8")
    archive = tmp_path / "replacement.tgz"
    with tarfile.open(archive, "w:gz") as output:
        output.add(replacement / "spoolman.db", arcname="spoolman.db")

    original_copy2 = shutil.copy2

    def fail_replacement_and_rollback(source, destination, *args, **kwargs):
        if STAGING_NAME in str(source) or ROLLBACK_NAME in str(source):
            raise OSError("simulated copy failure")
        return original_copy2(source, destination, *args, **kwargs)

    monkeypatch.setattr(shutil, "copy2", fail_replacement_and_rollback)

    with pytest.raises(RuntimeError, match="intact snapshot retained"):
        restore(data, archive)

    rollback = data / ROLLBACK_NAME
    assert (rollback / ROLLBACK_MARKER).is_file()
    assert (rollback / "spoolman.db").read_text(encoding="utf-8") == "live"
