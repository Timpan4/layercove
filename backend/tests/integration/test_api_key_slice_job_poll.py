"""A can_read_status API key can poll a slice job it started."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.app.core.auth import generate_api_key
from backend.app.models.api_key import APIKey
from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.user import User


@pytest.mark.asyncio
@pytest.mark.integration
async def test_api_key_can_poll_library_slice_job(async_client, db_session):
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "polladmin", "admin_password": "AdminPass1!"},
    )
    admin = (await db_session.execute(select(User).where(User.username == "polladmin"))).scalar_one()
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(APIKey(name="poll", key_hash=key_hash, key_prefix=key_prefix, user_id=admin.id))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    job = SliceJobRecord(
        owner_id=admin.id,
        source_kind="library_file",
        source_id=1,
        source_name="x.3mf",
        status="pending",
        created_at=now,
        expires_at=now + timedelta(hours=1),
    )
    db_session.add(job)
    await db_session.commit()

    response = await async_client.get(f"/api/v1/slice-jobs/{job.id}", headers={"X-API-Key": full_key})

    assert response.status_code == 200, response.text
    assert response.json()["job_id"] == job.id
