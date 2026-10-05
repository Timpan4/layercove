import os
import stat
from pathlib import Path
from unittest.mock import patch

from backend.app.services.virtual_printer.certificate import CertificateService


def test_private_keys_are_never_created_world_readable_even_if_chmod_fails(tmp_path):
    """Keys must be born 0600; the post-write chmod is not the only protection."""
    service = CertificateService(cert_dir=tmp_path, serial="TEST123")
    old_umask = os.umask(0)
    try:
        with patch.object(Path, "chmod", side_effect=PermissionError("not permitted")):
            service.generate_certificates()
    finally:
        os.umask(old_umask)

    for key in (service.ca_key_path, service.key_path):
        assert stat.S_IMODE(key.stat().st_mode) == 0o600
