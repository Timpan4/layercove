"""Additive backfill for slicer catalog metadata."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.slicer_profile_catalog import SlicerJobProvenance, SlicerProfileAccount
from backend.app.models.user import User
from backend.app.services.slicer_catalog_sync import sync_local_catalog


async def backfill_slicer_catalog_state(db: AsyncSession) -> None:
    """Create conservative catalog state for rows predating catalog support."""
    users = (
        await db.scalars(
            select(User).where((User.orca_cloud_token.is_not(None)) | (User.orca_cloud_refresh_token.is_not(None)))
        )
    ).all()
    for user in users:
        remote_account_id = user.orca_cloud_user_id or f"layercove-user:{user.id}"
        account = await db.scalar(
            select(SlicerProfileAccount).where(
                SlicerProfileAccount.source == "orca_cloud",
                SlicerProfileAccount.remote_account_id == remote_account_id,
            )
        )
        if account is None:
            db.add(
                SlicerProfileAccount(
                    user_id=user.id,
                    source="orca_cloud",
                    remote_account_id=remote_account_id,
                    display_name=user.orca_cloud_email or user.username,
                    sharing_state="pending",
                )
            )

    jobs_without_provenance = (
        await db.scalars(
            select(SliceJobRecord.id)
            .outerjoin(SlicerJobProvenance, SlicerJobProvenance.slice_job_id == SliceJobRecord.id)
            .where(SlicerJobProvenance.id.is_(None))
        )
    ).all()
    db.add_all(
        SlicerJobProvenance(slice_job_id=job_id, provenance_state="provenance_unknown")
        for job_id in jobs_without_provenance
    )

    await sync_local_catalog(db, skip_invalid=True, protect_references=False)
