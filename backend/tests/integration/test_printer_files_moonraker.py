"""Exercise printer-file routes against Moonraker's actual HTTP contracts."""

import asyncio
import io
import ipaddress
import zipfile
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio

from backend.app.api.routes import printers as routes
from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.services.bambu_ftp import DeleteResult
from backend.app.services.moonraker_http import MoonrakerHTTPClient


@pytest_asyncio.fixture
async def moon_files(printer_factory, db_session, monkeypatch):
    printer = await printer_factory(provider="moonraker", name="Tim Voron")
    config = MoonrakerPrinterConfig(printer_id=printer.id, base_url="http://printer.lan:7125")
    db_session.add(config)
    await db_session.commit()
    # The existing JSON-response ceiling must not truncate a binary G-code.
    content = b"; G-code\n" + b"G1 X1 Y1\n" * (64 * 1024 // 9 + 1)
    state = {"failed": False, "files": {"root.gcode": content, "nested/cube #1.gcode": content}}

    class InterruptedFile(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield content
            if event := state.get("pause"):
                event.set()
                await asyncio.Event().wait()
            raise httpx.ReadError("Private file transfer error")

    async def resolver(host, port):
        return {ipaddress.ip_address("192.168.1.25")}

    def handler(request):
        if state["failed"]:
            return httpx.Response(503, text="Private printer error")
        if request.url.path == "/server/files/directory":
            directory = request.url.params["path"]
            if directory not in {"gcodes", "gcodes/nested"}:
                return httpx.Response(404)
            prefix = "" if directory == "gcodes" else "nested/"
            names = [name[len(prefix) :] for name in state["files"] if name.startswith(prefix)]
            return httpx.Response(
                200,
                json={
                    "result": {
                        "dirs": [{"dirname": "nested", "size": 4096, "modified": 1700000000, "permissions": "rw"}]
                        if not prefix
                        else [],
                        "files": [
                            {"filename": name, "size": len(content), "modified": 1700000000, "permissions": "rw"}
                            for name in names
                            if "/" not in name
                        ],
                        "disk_usage": {"used": 100, "free": 900, "total": 1000},
                        "root_info": {"name": "gcodes", "permissions": "rw"},
                    }
                },
            )
        if request.url.path.startswith("/server/files/gcodes/"):
            name = request.url.path.removeprefix("/server/files/gcodes/")
            if request.method == "DELETE":
                if name == "locked.gcode":
                    return httpx.Response(409)
                if name not in state["files"]:
                    return httpx.Response(404)
                del state["files"][name]
                return httpx.Response(
                    200,
                    json={
                        "result": {
                            "action": "delete_file",
                            "item": {"root": "gcodes", "path": name},
                        }
                    },
                )
            if name in state["files"]:
                if state.get("interrupted") or state.get("pause"):
                    return httpx.Response(200, stream=InterruptedFile())
                return httpx.Response(200, content=state["files"][name])
            return httpx.Response(404)
        return httpx.Response(404)

    monkeypatch.setattr(
        routes,
        "MoonrakerHTTPClient",
        lambda **kwargs: MoonrakerHTTPClient(
            **kwargs,
            resolver=resolver,
            transport_factory=lambda *_: httpx.MockTransport(handler),
        ),
    )
    # Old routing safely returns empty/missing results instead of touching a real printer.
    monkeypatch.setattr(routes, "list_files_async", AsyncMock(return_value=[]))
    monkeypatch.setattr(routes, "download_file_bytes_async", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "delete_file_async", AsyncMock(return_value=DeleteResult.NOT_FOUND))
    monkeypatch.setattr(routes, "get_storage_info_async", AsyncMock(return_value=None))
    return printer, state, content


@pytest.mark.asyncio
async def test_moonraker_browses_root_and_nested_directory(async_client, moon_files):
    printer, _, _ = moon_files
    root = await async_client.get(f"/api/v1/printers/{printer.id}/files")
    assert root.status_code == 200
    files = {item["name"]: item for item in root.json()["files"]}
    assert files["root.gcode"]["path"] == "/root.gcode"
    assert files["nested"]["is_directory"] is True
    nested = await async_client.get(f"/api/v1/printers/{printer.id}/files", params={"path": "/nested"})
    assert nested.status_code == 200
    assert nested.json()["files"][0]["path"] == "/nested/cube #1.gcode"


@pytest.mark.asyncio
async def test_moonraker_file_failure_is_not_an_empty_directory(async_client, moon_files):
    printer, state, _ = moon_files
    state["failed"] = True
    response = await async_client.get(f"/api/v1/printers/{printer.id}/files")
    assert response.status_code == 502
    assert "files" not in response.json()
    assert "Private printer error" not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["download", "gcode"])
async def test_moonraker_download_and_preview_preserve_binary_file(async_client, moon_files, endpoint):
    printer, _, content = moon_files
    response = await async_client.get(
        f"/api/v1/printers/{printer.id}/files/{endpoint}",
        params={"path": "/nested/cube #1.gcode"},
    )
    assert response.status_code == 200
    assert response.content == content


@pytest.mark.asyncio
async def test_moonraker_zip_contains_selected_files(async_client, moon_files):
    printer, _, content = moon_files
    response = await async_client.post(
        f"/api/v1/printers/{printer.id}/files/download-zip",
        json={"paths": ["/root.gcode", "/nested/cube #1.gcode"]},
    )
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read("root.gcode") == content
        assert archive.read("cube #1.gcode") == content


@pytest.mark.asyncio
async def test_moonraker_delete_removes_only_the_requested_file(async_client, moon_files):
    printer, state, _ = moon_files
    response = await async_client.delete(
        f"/api/v1/printers/{printer.id}/files",
        params={"path": "/nested/cube #1.gcode"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "deleted", "path": "/nested/cube #1.gcode"}
    assert set(state["files"]) == {"root.gcode"}


@pytest.mark.asyncio
async def test_moonraker_storage_uses_the_gcode_filesystem(async_client, moon_files):
    printer, _, _ = moon_files
    response = await async_client.get(f"/api/v1/printers/{printer.id}/storage")
    assert response.status_code == 200
    assert response.json() == {"used_bytes": 100, "free_bytes": 900}


@pytest.mark.asyncio
async def test_moonraker_3mf_and_stl_viewer_sources(async_client, moon_files):
    printer, state, content = moon_files
    bundle = io.BytesIO()
    thumbnail = b"PNG thumbnail fixture"
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr("Metadata/plate_1.gcode", content)
        archive.writestr("Metadata/plate_1.png", thumbnail)
    state["files"]["plate.3mf"] = bundle.getvalue()
    state["files"]["cube.stl"] = b"solid cube\nendsolid cube\n"
    prefix = f"/api/v1/printers/{printer.id}/files"
    download = await async_client.get(f"{prefix}/download", params={"path": "/cube.stl"})
    assert download.content == state["files"]["cube.stl"]
    gcode = await async_client.get(f"{prefix}/gcode", params={"path": "/plate.3mf"})
    assert gcode.status_code == 200
    assert gcode.content == content
    plates = await async_client.get(f"{prefix}/plates", params={"path": "/plate.3mf"})
    assert plates.status_code == 200
    assert plates.json()["plates"][0]["index"] == 1
    assert plates.json()["plates"][0]["has_thumbnail"] is True
    thumb = await async_client.get(f"{prefix}/plate-thumbnail/1", params={"path": "/plate.3mf"})
    assert thumb.status_code == 200
    assert thumb.content == thumbnail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path", ["/../config/printer.cfg", "/nested/../root.gcode", "/nested\\root.gcode", "/nested//root.gcode"]
)
async def test_moonraker_rejects_paths_outside_the_gcode_root(async_client, moon_files, path):
    printer, state, _ = moon_files
    response = await async_client.delete(f"/api/v1/printers/{printer.id}/files", params={"path": path})
    assert response.status_code == 400
    assert set(state["files"]) == {"root.gcode", "nested/cube #1.gcode"}


@pytest.mark.asyncio
async def test_moonraker_preserves_server_deletion_rejection(async_client, moon_files):
    printer, state, _ = moon_files
    response = await async_client.delete(f"/api/v1/printers/{printer.id}/files", params={"path": "/locked.gcode"})
    assert response.status_code == 409
    assert set(state["files"]) == {"root.gcode", "nested/cube #1.gcode"}


@pytest.mark.asyncio
@pytest.mark.parametrize("interrupted", [False, True])
async def test_moonraker_download_cleans_staged_files(async_client, moon_files, tmp_path, monkeypatch, interrupted):
    printer, state, content = moon_files
    transfer_directory = tmp_path / "transfers"
    transfer_directory.mkdir()
    monkeypatch.setattr(routes.tempfile, "tempdir", str(transfer_directory))
    state["interrupted"] = interrupted
    response = await async_client.get(f"/api/v1/printers/{printer.id}/files/download", params={"path": "/root.gcode"})
    assert response.status_code == (502 if interrupted else 200)
    if not interrupted:
        assert response.content == content
    assert "Private file transfer error" not in response.text
    assert not list(transfer_directory.iterdir())


@pytest.mark.asyncio
async def test_moonraker_cancelled_download_cleans_staged_file(async_client, moon_files, tmp_path, monkeypatch):
    printer, state, _ = moon_files
    transfer_directory = tmp_path / "transfers"
    transfer_directory.mkdir()
    monkeypatch.setattr(routes.tempfile, "tempdir", str(transfer_directory))
    state["pause"] = ready = asyncio.Event()
    task = asyncio.create_task(
        async_client.get(
            f"/api/v1/printers/{printer.id}/files/download",
            params={"path": "/root.gcode"},
        )
    )
    await ready.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not list(transfer_directory.iterdir())


@pytest.mark.asyncio
async def test_bambu_files_keep_existing_ftp_routing(async_client, moon_files, printer_factory, monkeypatch):
    printer = await printer_factory()
    monkeypatch.setattr(
        routes,
        "list_files_async",
        AsyncMock(
            return_value=[
                {
                    "name": "benchy.3mf",
                    "size": 1024,
                    "is_directory": False,
                }
            ]
        ),
    )
    response = await async_client.get(f"/api/v1/printers/{printer.id}/files", params={"path": "/model"})
    assert response.status_code == 200
    assert response.json()["files"][0]["path"] == "/model/benchy.3mf"
