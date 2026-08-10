"""Local preset mutations mirror immutable attributed catalog revisions."""

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

import backend.app.models  # noqa: F401
from backend.app.api.routes.local_presets import (
    create_local_preset,
    delete_local_preset,
    update_local_preset,
)
from backend.app.core.database import Base
from backend.app.models.printer import Printer
from backend.app.models.slice_job import SliceJobRecord  # noqa: F401
from backend.app.models.slicer_profile_catalog import (
    SlicerCompatibilityMapping,
    SlicerProfile,
    SlicerProfileRevision,
)
from backend.app.models.user import User
from backend.app.schemas.local_preset import LocalPresetCreate, LocalPresetUpdate


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def test_local_create_update_and_delete_mirror_attributed_catalog_history(db):
    actor = User(username="local-editor")
    db.add(actor)
    await db.flush()

    created = await create_local_preset(
        LocalPresetCreate(
            name="Local P1S process",
            preset_type="process",
            setting={"type": "process", "layer_height": "0.20"},
        ),
        actor,
        db,
    )
    profile = await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == str(created.id)))
    assert profile is not None
    revisions = (
        await db.scalars(
            select(SlicerProfileRevision)
            .where(SlicerProfileRevision.profile_id == profile.id)
            .order_by(SlicerProfileRevision.id)
        )
    ).all()
    assert [(revision.content["layer_height"], revision.created_by_user_id) for revision in revisions] == [
        ("0.20", actor.id)
    ]

    await update_local_preset(
        created.id,
        LocalPresetUpdate(setting={"type": "process", "layer_height": "0.16"}),
        actor,
        db,
    )
    revisions = (
        await db.scalars(
            select(SlicerProfileRevision)
            .where(SlicerProfileRevision.profile_id == profile.id)
            .order_by(SlicerProfileRevision.id)
        )
    ).all()
    assert [(revision.content["layer_height"], revision.created_by_user_id) for revision in revisions] == [
        ("0.20", actor.id),
        ("0.16", actor.id),
    ]

    printer = Printer(name="Referenced target", provider="bambu", is_active=True)
    db.add(printer)
    await db.flush()
    mapping = SlicerCompatibilityMapping(profile_id=profile.id, printer_id=printer.id)
    db.add(mapping)
    await db.commit()
    actor_id = actor.id
    mapping_id = mapping.id
    with pytest.raises(HTTPException) as referenced:
        await delete_local_preset(created.id, actor, db)
    assert referenced.value.status_code == 409
    assert referenced.value.detail["code"] == "profile_replacement_required"
    await db.rollback()

    actor = await db.get(User, actor_id)
    mapping = await db.get(SlicerCompatibilityMapping, mapping_id)
    await db.delete(mapping)
    await db.flush()
    await delete_local_preset(created.id, actor, db)
    await db.refresh(profile)
    assert profile.tombstoned_at is not None
