"""Versioned production Orca schema and profile discovery routes."""

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.cloud import resolve_api_key_cloud_owner
from backend.app.api.routes.settings import get_setting
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.config import settings
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.schemas.slicer import PresetRef
from backend.app.schemas.slicer_contract import (
    ResolvedSlicerProfileResponse,
    SlicerCapabilitiesResponse,
    SlicerProcessSchemaResponse,
)
from backend.app.services.preset_resolver import resolve_preset_ref
from backend.app.services.slicer_api import (
    SlicerApiError,
    SlicerApiService,
    SlicerSchemaMismatchError,
)

router = APIRouter(prefix="/slicer", tags=["slicer"])


async def resolve_orca_api_url(db: AsyncSession) -> str:
    configured = await get_setting(db, "orcaslicer_api_url")
    return (configured or settings.slicer_api_url).strip()


async def _orca_service(db: AsyncSession) -> SlicerApiService:
    return SlicerApiService(await resolve_orca_api_url(db))


def _contract_error(exc: SlicerApiError) -> HTTPException:
    if isinstance(exc, SlicerSchemaMismatchError):
        return HTTPException(
            status_code=409,
            detail={"code": "slicer_schema_mismatch", "detail": str(exc)},
        )
    return HTTPException(status_code=502, detail={"code": "slicer_unavailable", "detail": str(exc)})


@router.get("/capabilities", response_model=SlicerCapabilitiesResponse)
async def get_slicer_capabilities(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.LIBRARY_UPLOAD),
) -> SlicerCapabilitiesResponse:
    service = await _orca_service(db)
    try:
        return await service.capabilities()
    except SlicerApiError as exc:
        raise _contract_error(exc) from exc
    finally:
        await service.close()


@router.get("/schema/process", response_model=SlicerProcessSchemaResponse)
async def get_process_schema(
    refresh: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.LIBRARY_UPLOAD),
) -> SlicerProcessSchemaResponse:
    service = await _orca_service(db)
    try:
        return await service.process_schema(refresh=refresh)
    except SlicerApiError as exc:
        raise _contract_error(exc) from exc
    finally:
        await service.close()


@router.get("/profiles/{preset_type}", response_model=ResolvedSlicerProfileResponse)
async def get_resolved_profile(
    preset_type: str,
    source: str = Query(...),
    id: str = Query(..., min_length=1, max_length=512),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.LIBRARY_UPLOAD),
    api_key_cloud_owner: User | None = Depends(resolve_api_key_cloud_owner),
) -> ResolvedSlicerProfileResponse:
    if preset_type not in ("printer", "process", "filament"):
        raise HTTPException(status_code=404, detail="Slicer profile type not found")
    try:
        ref = PresetRef(source=source, id=id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid slicer profile reference") from exc
    raw = await resolve_preset_ref(db, current_user or api_key_cloud_owner, ref, preset_type)
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Resolved slicer profile is invalid JSON") from exc
    if not isinstance(values, dict):
        raise HTTPException(status_code=502, detail="Resolved slicer profile must be a JSON object")
    return ResolvedSlicerProfileResponse(
        preset_type=preset_type,
        source=ref.source,
        id=ref.id,
        values=values,
    )
