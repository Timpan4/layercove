import logging

from backend.app.core.auth import _get_jwt_secret


def test_short_env_jwt_secret_logs_warning(monkeypatch, caplog):
    monkeypatch.setenv("JWT_SECRET_KEY", "short")
    with caplog.at_level(logging.WARNING, logger="backend.app.core.auth"):
        assert _get_jwt_secret() == "short"
    assert "shorter than 32" in caplog.text


def test_long_env_jwt_secret_does_not_warn(monkeypatch, caplog):
    monkeypatch.setenv("JWT_SECRET_KEY", "x" * 32)
    with caplog.at_level(logging.WARNING, logger="backend.app.core.auth"):
        _get_jwt_secret()
    assert "shorter than 32" not in caplog.text
