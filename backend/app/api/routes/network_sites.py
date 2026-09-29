from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.network_site import NetworkSite
from backend.app.models.printer import Printer
from backend.app.schemas.network_site import (
    NetworkSiteCreate,
    NetworkSiteResponse,
    NetworkSiteUpdate,
    four_via_six_cidr,
)

router = APIRouter(prefix="/network-sites", tags=["network-sites"])


def _response(site: NetworkSite, printer_count: int = 0) -> NetworkSiteResponse:
    return NetworkSiteResponse(
        id=site.id,
        name=site.name,
        site_number=site.site_number,
        ipv4_cidr=site.ipv4_cidr,
        four_via_six_cidr=four_via_six_cidr(site.site_number, site.ipv4_cidr),
        printer_count=printer_count,
    )


@router.get("", response_model=list[NetworkSiteResponse])
async def list_network_sites(
    _=RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(NetworkSite, func.count(Printer.id))
        .outerjoin(Printer, Printer.network_site_id == NetworkSite.id)
        .group_by(NetworkSite.id)
        .order_by(func.lower(NetworkSite.name))
    )
    return [_response(site, count) for site, count in result.all()]


@router.post("", response_model=NetworkSiteResponse, status_code=status.HTTP_201_CREATED)
async def create_network_site(
    site_data: NetworkSiteCreate,
    _=RequirePermissionIfAuthEnabled(Permission.PRINTERS_CREATE),
    db: AsyncSession = Depends(get_db),
):
    site = NetworkSite(**site_data.model_dump())
    db.add(site)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "Network site name or site number already exists") from exc
    await db.refresh(site)
    return _response(site)


@router.patch("/{site_id}", response_model=NetworkSiteResponse)
async def update_network_site(
    site_id: int,
    site_data: NetworkSiteUpdate,
    _=RequirePermissionIfAuthEnabled(Permission.PRINTERS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    site = await db.get(NetworkSite, site_id)
    if site is None:
        raise HTTPException(404, "Network site not found")

    printer_count = await db.scalar(select(func.count(Printer.id)).where(Printer.network_site_id == site_id)) or 0
    updates = site_data.model_dump(exclude_unset=True)
    if printer_count and ({"site_number", "ipv4_cidr"} & updates.keys()):
        raise HTTPException(409, "Remove assigned printers before changing the site number or subnet")
    for field, value in updates.items():
        setattr(site, field, value)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "Network site name or site number already exists") from exc
    await db.refresh(site)
    return _response(site, printer_count)


@router.delete("/{site_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_network_site(
    site_id: int,
    _=RequirePermissionIfAuthEnabled(Permission.PRINTERS_DELETE),
    db: AsyncSession = Depends(get_db),
):
    site = await db.get(NetworkSite, site_id)
    if site is None:
        raise HTTPException(404, "Network site not found")
    printer_count = await db.scalar(select(func.count(Printer.id)).where(Printer.network_site_id == site_id)) or 0
    if printer_count:
        raise HTTPException(409, "Remove assigned printers before deleting this network site")
    await db.delete(site)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
