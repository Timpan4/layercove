"""Unit tests for #1457 stale fallback-tag cleanup.

When a user (re)assigns or (re)links a Spoolman spool to an AMS slot, any OTHER
Spoolman spool whose extra.tag still holds the same value is stale — the hover
card and fill-level lookup would surface the wrong spool. The cleanup helper
clears extra.tag on those orphans.
"""

import json
from unittest.mock import ANY, AsyncMock, MagicMock

import pytest

from backend.app.api.routes.spoolman_inventory import (
    _clear_stale_slot_fallback_tag_links,
    _clear_stale_tag_links,
)
from backend.app.services.spoolman import SpoolmanClientError
from backend.app.services.spoolman_tracking import get_fallback_spool_tag_for_slot


def _make_client(spools, *, merge_side_effect=None):
    client = MagicMock()
    client.get_spools = AsyncMock(return_value=spools)
    client.merge_spool_extra = AsyncMock(
        side_effect=merge_side_effect,
        return_value={"id": 0, "extra": {}},
    )
    return client


@pytest.mark.asyncio
class TestClearStaleTagLinks:
    async def test_clears_other_spools_with_same_tag(self):
        target_tag = "AABBCCDDEEFF0011"
        client = _make_client(
            [
                {"id": 7, "extra": {"tag": json.dumps(target_tag)}},  # stale orphan -> clear
                {"id": 8, "extra": {"tag": json.dumps("UNRELATED12345678")}},  # different tag -> keep
                {"id": 9, "extra": {"tag": json.dumps(target_tag)}},  # newly bound -> keep_spool_id
                {"id": 10, "extra": {}},  # no tag -> keep
            ]
        )

        cleared = await _clear_stale_tag_links(client, tag=target_tag, keep_spool_id=9, log_context="test")

        assert cleared == 1
        client.merge_spool_extra.assert_called_once_with(7, {"tag": json.dumps("")}, only_if=ANY)

    async def test_case_insensitive_match(self):
        target_tag = "aabbccdd11223344"
        client = _make_client([{"id": 5, "extra": {"tag": json.dumps(target_tag.upper())}}])

        cleared = await _clear_stale_tag_links(client, tag=target_tag, keep_spool_id=99, log_context="test")

        assert cleared == 1

    async def test_empty_tag_no_op(self):
        client = _make_client([{"id": 1, "extra": {"tag": json.dumps("AABB")}}])

        cleared = await _clear_stale_tag_links(client, tag="", keep_spool_id=99, log_context="test")

        assert cleared == 0
        client.get_spools.assert_not_called()
        client.merge_spool_extra.assert_not_called()

    async def test_skips_keep_spool_id(self):
        target_tag = "AABB00112233CCDD"
        client = _make_client([{"id": 42, "extra": {"tag": json.dumps(target_tag)}}])

        cleared = await _clear_stale_tag_links(client, tag=target_tag, keep_spool_id=42, log_context="test")

        assert cleared == 0
        client.merge_spool_extra.assert_not_called()

    async def test_swallows_get_spools_error(self):
        client = MagicMock()
        client.get_spools = AsyncMock(side_effect=SpoolmanClientError("boom", status_code=500))
        client.merge_spool_extra = AsyncMock()

        cleared = await _clear_stale_tag_links(client, tag="AABB00112233CCDD", keep_spool_id=99, log_context="test")

        assert cleared == 0
        client.merge_spool_extra.assert_not_called()

    async def test_continues_when_one_patch_fails(self):
        target_tag = "AABB00112233CCDD"
        client = _make_client(
            [
                {"id": 1, "extra": {"tag": json.dumps(target_tag)}},
                {"id": 2, "extra": {"tag": json.dumps(target_tag)}},
            ],
            merge_side_effect=[SpoolmanClientError("first fails", status_code=500), {"id": 2, "extra": {}}],
        )

        cleared = await _clear_stale_tag_links(client, tag=target_tag, keep_spool_id=99, log_context="test")

        assert cleared == 1
        assert client.merge_spool_extra.call_count == 2


@pytest.mark.asyncio
class TestClearStaleSlotFallbackTagLinks:
    async def test_computes_fallback_tag_and_clears(self):
        serial = "ABCDEF123456"
        ams_id, tray_id = 0, 2
        fallback_tag = get_fallback_spool_tag_for_slot(serial, ams_id, tray_id)
        assert fallback_tag, "sanity: helper must produce a tag for a real serial"

        client = _make_client([{"id": 11, "extra": {"tag": json.dumps(fallback_tag)}}])

        cleared = await _clear_stale_slot_fallback_tag_links(
            client,
            printer_serial=serial,
            ams_id=ams_id,
            tray_id=tray_id,
            keep_spool_id=22,
        )

        assert cleared == 1
        client.merge_spool_extra.assert_called_once_with(11, {"tag": json.dumps("")}, only_if=ANY)

    async def test_empty_serial_no_op(self):
        client = _make_client([{"id": 1, "extra": {"tag": json.dumps("AABB")}}])

        cleared = await _clear_stale_slot_fallback_tag_links(
            client,
            printer_serial="",
            ams_id=0,
            tray_id=0,
            keep_spool_id=1,
        )

        assert cleared == 0
        client.get_spools.assert_not_called()


@pytest.mark.asyncio
class TestStaleTagCleanupRace:
    async def test_does_not_erase_tag_rebound_after_enumeration(self):
        """Spool 7 held tag T when enumerated, but was rebound to U before the clear."""
        from backend.app.services.spoolman import SpoolmanClient

        target_tag = "AABBCCDDEEFF0011"
        client = SpoolmanClient("http://localhost:7912")
        client.get_spools = AsyncMock(return_value=[{"id": 7, "extra": {"tag": json.dumps(target_tag)}}])
        client.get_spool = AsyncMock(return_value={"id": 7, "extra": {"tag": json.dumps("1122334455667788")}})
        client.update_spool_full = AsyncMock()

        cleared = await _clear_stale_tag_links(client, tag=target_tag, keep_spool_id=9, log_context="test")

        assert cleared == 0
        client.update_spool_full.assert_not_called()
