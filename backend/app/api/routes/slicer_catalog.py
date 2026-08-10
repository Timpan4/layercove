"""Persistent slicer catalog administration and read APIs."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.cloud import get_stored_token
from backend.app.api.routes.orca_cloud import _build_authenticated_service, _load_credentials
from backend.app.api.routes.slicer_presets import _fetch_cloud_presets, _resolve_slicer_api_url
from backend.app.core.auth import RequireAnyPermissionIfAuthEnabled, RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.slicer_profile_catalog import (
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileActivationEvent,
    SlicerProfileReviewBatch,
    SlicerProfileRevision,
)
from backend.app.models.user import User
from backend.app.services.orca_cloud import OrcaCloudError
from backend.app.services.slicer_api import SlicerApiError, SlicerApiService
from backend.app.services.slicer_catalog import (
    activate_revision,
    approve_review_batch,
    get_revision_content,
    mark_account_stale,
    rollback_revision,
)
from backend.app.services.slicer_catalog_sync import sync_cloud_account, sync_orca_account, sync_standard_account

router = APIRouter(prefix="/slicer/catalog", tags=["Slicer Catalog"])


class SharingRequest(BaseModel):
    shared: bool


class ReviewRequest(BaseModel):
    approved: bool
    revision_ids: list[int] | None = None


class ActivationRequest(BaseModel):
    revision_id: int


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@router.get("/profiles")
async def list_catalog_profiles(
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    include_inactive: bool = False,
) -> list[dict[str, Any]]:
    visibility = SlicerProfileAccount.sharing_state == "shared"
    if current_user is not None:
        visibility = or_(visibility, SlicerProfileAccount.user_id == current_user.id)
    else:
        visibility = or_(visibility, SlicerProfileAccount.user_id.is_(None))
    if not include_inactive:
        rows = (
            await db.execute(
                select(SlicerProfile, SlicerProfileRevision, SlicerProfileAccount)
                .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
                .join(SlicerProfileActivation, SlicerProfileActivation.profile_id == SlicerProfile.id)
                .join(SlicerProfileRevision, SlicerProfileRevision.id == SlicerProfileActivation.revision_id)
                .where(visibility)
                .order_by(SlicerProfile.display_name, SlicerProfile.id)
            )
        ).all()
        return [
            {
                "profile_id": profile.id,
                "revision_id": revision.id,
                "source": account.source,
                "account_id": account.id,
                "account_name": account.display_name,
                "remote_profile_id": profile.remote_profile_id,
                "profile_type": profile.profile_type,
                "display_name": profile.display_name,
                "content_hash": revision.content_hash,
                "compatibility_metadata": (revision.resolved_metadata or {}).get("metadata", {}),
                "tombstoned": profile.tombstoned_at is not None,
                "stale": profile.stale_at is not None,
                "sharing_state": account.sharing_state,
            }
            for profile, revision, account in rows
        ]

    latest_revision = (
        select(func.max(SlicerProfileRevision.id))
        .where(SlicerProfileRevision.profile_id == SlicerProfile.id)
        .correlate(SlicerProfile)
        .scalar_subquery()
    )
    rows = (
        await db.execute(
            select(SlicerProfile, SlicerProfileAccount, SlicerProfileRevision, SlicerProfileActivation)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .outerjoin(SlicerProfileRevision, SlicerProfileRevision.id == latest_revision)
            .outerjoin(SlicerProfileActivation, SlicerProfileActivation.profile_id == SlicerProfile.id)
            .where(visibility)
            .order_by(SlicerProfile.display_name, SlicerProfile.id)
        )
    ).all()
    return [
        {
            "profile_id": profile.id,
            "revision_id": revision.id if revision is not None else None,
            "latest_revision_id": revision.id if revision is not None else None,
            "current_revision_id": revision.id if revision is not None else None,
            "active_revision_id": activation.revision_id if activation is not None else None,
            "active": activation is not None,
            "review_state": revision.review_state if revision is not None else None,
            "source": account.source,
            "account_id": account.id,
            "account_name": account.display_name,
            "remote_profile_id": profile.remote_profile_id,
            "profile_type": profile.profile_type,
            "display_name": profile.display_name,
            "content_hash": revision.content_hash if revision is not None else None,
            "compatibility_metadata": (revision.resolved_metadata or {}).get("metadata", {}) if revision else {},
            "tombstoned": profile.tombstoned_at is not None,
            "stale": profile.stale_at is not None,
            "sharing_state": account.sharing_state,
        }
        for profile, account, revision, activation in rows
    ]


@router.get("/profiles/{profile_id}/revisions")
async def list_catalog_profile_revisions(
    profile_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
) -> list[dict[str, Any]]:
    visibility = SlicerProfileAccount.sharing_state == "shared"
    if current_user is not None:
        visibility = or_(visibility, SlicerProfileAccount.user_id == current_user.id)
    else:
        visibility = or_(visibility, SlicerProfileAccount.user_id.is_(None))
    profile = await db.scalar(
        select(SlicerProfile)
        .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
        .where(SlicerProfile.id == profile_id, visibility)
    )
    if profile is None:
        raise HTTPException(status_code=404, detail="Catalog profile not found")
    activation = await db.scalar(
        select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == profile_id)
    )
    activation_events = (
        await db.scalars(
            select(SlicerProfileActivationEvent)
            .where(SlicerProfileActivationEvent.profile_id == profile_id)
            .order_by(SlicerProfileActivationEvent.id)
        )
    ).all()
    rows = (
        (
            await db.execute(
                select(SlicerProfileRevision)
                .join(SlicerProfile, SlicerProfile.id == SlicerProfileRevision.profile_id)
                .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
                .where(SlicerProfileRevision.profile_id == profile_id, visibility)
                .order_by(SlicerProfileRevision.id)
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": revision.id,
            "content_hash": revision.content_hash,
            "review_state": revision.review_state,
            "created_at": revision.created_at,
            "activations": [
                {
                    "action": event.action,
                    "activated_by_user_id": event.activated_by_user_id,
                    "activated_at": event.activated_at,
                }
                for event in activation_events
                if event.revision_id == revision.id
            ],
            "active": activation is not None and activation.revision_id == revision.id,
        }
        for revision in rows
    ]


@router.get("/revisions/{revision_id}")
async def get_catalog_revision(
    revision_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
) -> dict[str, Any]:
    visibility = SlicerProfileAccount.sharing_state == "shared"
    if current_user is not None:
        visibility = or_(visibility, SlicerProfileAccount.user_id == current_user.id)
    else:
        visibility = or_(visibility, SlicerProfileAccount.user_id.is_(None))
    revision = await db.scalar(
        select(SlicerProfileRevision)
        .join(SlicerProfile, SlicerProfile.id == SlicerProfileRevision.profile_id)
        .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
        .where(SlicerProfileRevision.id == revision_id, visibility)
    )
    if revision is None:
        raise HTTPException(status_code=404, detail="Catalog revision not found")
    return {
        "id": revision.id,
        "profile_id": revision.profile_id,
        "content_hash": revision.content_hash,
        "review_state": revision.review_state,
        "content": await get_revision_content(db, revision.id),
        "resolved_metadata": revision.resolved_metadata,
        "created_at": revision.created_at,
    }


@router.get("/accounts")
async def list_catalog_accounts(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
) -> list[dict[str, Any]]:
    accounts = (await db.scalars(select(SlicerProfileAccount).order_by(SlicerProfileAccount.id))).all()
    return [
        {
            "id": account.id,
            "source": account.source,
            "remote_account_id": account.remote_account_id,
            "display_name": account.display_name,
            "sharing_state": account.sharing_state,
            "consent_at": account.consent_at,
            "sync_cursor": account.sync_cursor,
            "last_sync_at": account.last_sync_at,
            "last_successful_sync_at": account.last_successful_sync_at,
            "last_sync_error": account.last_sync_error,
            "sync_frozen": account.sync_frozen,
        }
        for account in accounts
    ]


@router.post("/orca/sync")
async def sync_orca_catalog(
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.ORCA_CLOUD_AUTH),
) -> dict[str, Any]:
    credentials = await _load_credentials(db, current_user)
    if not credentials.token:
        raise HTTPException(status_code=401, detail="Orca Cloud is not connected")
    remote_account_id = credentials.user_id or (
        f"layercove-user:{current_user.id}" if current_user is not None else "layercove-installation"
    )
    account = await db.scalar(
        select(SlicerProfileAccount).where(
            SlicerProfileAccount.source == "orca_cloud",
            SlicerProfileAccount.remote_account_id == remote_account_id,
        )
    )
    if account is not None and account.sync_frozen:
        raise HTTPException(status_code=409, detail="Catalog account is frozen")
    service = await _build_authenticated_service(db, current_user)
    try:
        result = await sync_orca_account(
            db,
            service,
            remote_account_id=remote_account_id,
            display_name=credentials.email or remote_account_id,
            user_id=current_user.id if current_user is not None else None,
        )
    except OrcaCloudError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        await service.close()
    return {
        "account_id": result.account_id,
        "review_batch_id": result.review_batch_id,
        "revision_ids": result.revision_ids,
        "cursor": result.cursor,
    }


@router.post("/cloud/sync")
async def sync_cloud_catalog(
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.CLOUD_AUTH),
) -> dict[str, Any]:
    _token, account_email, region = await get_stored_token(db, current_user)
    if not account_email:
        raise HTTPException(status_code=409, detail="Cloud account identity is unavailable")
    remote_account_id = f"{region}:{account_email.strip().casefold()}"
    account = await db.scalar(
        select(SlicerProfileAccount).where(
            SlicerProfileAccount.source == "cloud",
            SlicerProfileAccount.remote_account_id == remote_account_id,
        )
    )
    if account is not None and account.sync_frozen:
        raise HTTPException(status_code=409, detail="Catalog account is frozen")
    slots, status = await _fetch_cloud_presets(db, current_user, refresh=True)
    if status != "ok":
        code = 401 if status in {"not_authenticated", "expired"} else 502
        raise HTTPException(status_code=code, detail=f"Cloud profile sync is {status}")
    snapshot = {
        profile_type: [profile.model_dump(mode="json") for profile in profiles]
        for profile_type, profiles in slots.items()
    }
    try:
        result = await sync_cloud_account(
            db,
            snapshot,
            remote_account_id=remote_account_id,
            display_name=account_email,
            user_id=current_user.id if current_user is not None else None,
        )
    except ValueError as error:
        status_code = 409 if "frozen" in str(error) else 422
        raise HTTPException(status_code=status_code, detail=str(error)) from error
    return {
        "account_id": result.account_id,
        "review_batch_id": result.review_batch_id,
        "revision_ids": result.revision_ids,
        "cursor": result.cursor,
    }


@router.post("/standard/sync")
async def sync_standard_catalog(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> dict[str, Any]:
    account = await db.scalar(
        select(SlicerProfileAccount).where(
            SlicerProfileAccount.source == "standard",
            SlicerProfileAccount.remote_account_id == "bundled",
        )
    )
    if account is not None and account.sync_frozen:
        raise HTTPException(status_code=409, detail="Catalog account is frozen")
    api_url = await _resolve_slicer_api_url(db)
    if not api_url:
        raise HTTPException(status_code=409, detail="Slicer sidecar is not configured")
    try:
        async with SlicerApiService(base_url=api_url) as service:
            snapshot = await service.list_bundled_profiles()
        result = await sync_standard_account(db, snapshot)
    except SlicerApiError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {
        "account_id": result.account_id,
        "review_batch_id": result.review_batch_id,
        "revision_ids": result.revision_ids,
        "cursor": result.cursor,
    }


@router.put("/accounts/{account_id}/sharing")
async def set_account_sharing(
    account_id: int,
    request: SharingRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequireAnyPermissionIfAuthEnabled(Permission.CLOUD_AUTH, Permission.ORCA_CLOUD_AUTH),
) -> dict[str, Any]:
    account = await db.get(SlicerProfileAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Catalog account not found")
    if account.source not in {"cloud", "orca_cloud"}:
        raise HTTPException(status_code=422, detail="Only account-owned cloud catalogs have sharing consent")
    if current_user is not None and account.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the connected account owner can change sharing consent")
    required_permission = Permission.CLOUD_AUTH if account.source == "cloud" else Permission.ORCA_CLOUD_AUTH
    if current_user is not None and not current_user.has_permission(required_permission.value):
        raise HTTPException(status_code=403, detail=f"Missing required permission: {required_permission.value}")
    account.sharing_state = "shared" if request.shared else "private"
    account.consent_at = _utc_now_naive() if request.shared else None
    await db.commit()
    return {"id": account.id, "sharing_state": account.sharing_state, "consent_at": account.consent_at}


@router.get("/accounts/{account_id}/reviews")
async def list_review_batches(
    account_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
) -> list[dict[str, Any]]:
    batches = (
        await db.scalars(
            select(SlicerProfileReviewBatch)
            .where(SlicerProfileReviewBatch.account_id == account_id)
            .order_by(SlicerProfileReviewBatch.id.desc())
        )
    ).all()
    revision_rows = (
        await db.execute(
            select(SlicerProfileRevision, SlicerProfile)
            .join(SlicerProfile, SlicerProfile.id == SlicerProfileRevision.profile_id)
            .join(
                SlicerProfileReviewBatch,
                SlicerProfileReviewBatch.id == SlicerProfileRevision.review_batch_id,
            )
            .where(SlicerProfileReviewBatch.account_id == account_id)
            .order_by(SlicerProfileRevision.id)
        )
    ).all()
    revisions_by_batch: dict[int, list[dict[str, Any]]] = {}
    for revision, profile in revision_rows:
        if revision.review_batch_id is not None:
            revisions_by_batch.setdefault(revision.review_batch_id, []).append(
                {
                    "id": revision.id,
                    "profile_id": profile.id,
                    "display_name": profile.display_name,
                }
            )
    return [
        {
            "id": batch.id,
            "status": batch.status,
            "summary": batch.summary,
            "revisions": revisions_by_batch.get(batch.id, []),
            "sync_cursor_before": batch.sync_cursor_before,
            "sync_cursor_after": batch.sync_cursor_after,
            "reviewed_at": batch.reviewed_at,
            "created_at": batch.created_at,
        }
        for batch in batches
    ]


@router.post("/reviews/{batch_id}")
async def review_batch(
    batch_id: int,
    request: ReviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> dict[str, Any]:
    batch = await db.get(SlicerProfileReviewBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Review batch not found")
    if batch.status != "pending":
        raise HTTPException(status_code=409, detail="Review batch is already finalized")
    if request.approved:
        try:
            await approve_review_batch(
                db,
                batch_id,
                current_user.id if current_user is not None else None,
                request.revision_ids,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    else:
        if request.revision_ids is not None:
            raise HTTPException(status_code=422, detail="revision_ids are valid only when approving a batch")
        batch.status = "rejected"
        batch.reviewed_by_user_id = current_user.id if current_user is not None else None
        batch.reviewed_at = _utc_now_naive()
        revisions = (
            await db.scalars(select(SlicerProfileRevision).where(SlicerProfileRevision.review_batch_id == batch_id))
        ).all()
        for revision in revisions:
            revision.review_state = "rejected"
    await db.commit()
    return {"id": batch.id, "status": batch.status}


@router.post("/profiles/{profile_id}/activate")
async def activate_catalog_profile(
    profile_id: int,
    request: ActivationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> dict[str, Any]:
    revision = await db.get(SlicerProfileRevision, request.revision_id)
    if revision is None or revision.profile_id != profile_id:
        raise HTTPException(status_code=422, detail="Revision does not belong to profile")
    try:
        activation = await activate_revision(db, revision.id, current_user.id if current_user is not None else None)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    await db.commit()
    return {"profile_id": profile_id, "revision_id": activation.revision_id}


@router.post("/profiles/{profile_id}/rollback")
async def rollback_catalog_profile(
    profile_id: int,
    request: ActivationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> dict[str, Any]:
    try:
        activation = await rollback_revision(
            db,
            profile_id,
            request.revision_id,
            current_user.id if current_user is not None else None,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    await db.commit()
    return {"profile_id": profile_id, "revision_id": activation.revision_id}


@router.post("/accounts/{account_id}/freeze")
async def freeze_catalog_account(
    account_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> dict[str, Any]:
    account = await db.get(SlicerProfileAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Catalog account not found")
    account.sync_frozen = True
    await mark_account_stale(db, account_id, error="disconnected")
    await db.commit()
    return {"id": account_id, "stale": True, "sync_frozen": True}


@router.post("/accounts/{account_id}/resume")
async def resume_catalog_account(
    account_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> dict[str, Any]:
    account = await db.get(SlicerProfileAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Catalog account not found")
    account.sync_frozen = False
    await db.commit()
    return {"id": account_id, "stale": account.last_sync_error is not None, "sync_frozen": False}
