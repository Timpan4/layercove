"""Focused tests for application-secret Fernet key resolution."""

import pytest
from cryptography.fernet import Fernet

from backend.app.core import encryption


def test_matching_environment_aliases_use_shared_key(monkeypatch, tmp_path):
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("LAYERCOVE_SECRET_ENCRYPTION_KEY", key)
    monkeypatch.setenv("MFA_ENCRYPTION_KEY", key)

    resolved_key, source = encryption._load_or_generate_key()

    assert (resolved_key, source) == (key, "env")
    assert not (tmp_path / ".mfa_encryption_key").exists()
    ciphertext = encryption.encrypt_application_secret("credential")
    assert encryption.decrypt_application_secret(ciphertext) == "credential"
    with pytest.raises(RuntimeError, match="not encrypted"):
        encryption.decrypt_application_secret("credential")


def test_conflicting_environment_aliases_fail_closed(monkeypatch, tmp_path):
    monkeypatch.setenv("LAYERCOVE_SECRET_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("MFA_ENCRYPTION_KEY", Fernet.generate_key().decode())
    (tmp_path / ".mfa_encryption_key").write_text(Fernet.generate_key().decode())

    resolved_key, source = encryption._load_or_generate_key()

    assert (resolved_key, source) == (None, "none")
    with pytest.raises(RuntimeError, match="key is unavailable"):
        encryption.encrypt_application_secret("credential")


def test_invalid_preferred_alias_fails_closed(monkeypatch, tmp_path):
    monkeypatch.setenv("LAYERCOVE_SECRET_ENCRYPTION_KEY", "invalid-key")
    (tmp_path / ".mfa_encryption_key").write_text(Fernet.generate_key().decode())

    resolved_key, source = encryption._load_or_generate_key()

    assert (resolved_key, source) == (None, "none")
    with pytest.raises(RuntimeError, match="key is unavailable"):
        encryption.encrypt_application_secret("credential")


def test_invalid_mfa_alias_keeps_legacy_file_fallback(monkeypatch, tmp_path):
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("MFA_ENCRYPTION_KEY", "invalid-key")
    (tmp_path / ".mfa_encryption_key").write_text(key)

    assert encryption._load_or_generate_key() == (key, "file")


def test_application_secret_functions_never_fallback_to_plaintext(monkeypatch):
    monkeypatch.setattr(encryption, "_load_or_generate_key", lambda: (None, "none"))

    with pytest.raises(RuntimeError, match="key is unavailable"):
        encryption.encrypt_application_secret("credential")
    with pytest.raises(RuntimeError, match="key is unavailable"):
        encryption.decrypt_application_secret("credential")
