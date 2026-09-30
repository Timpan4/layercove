"""Guided calibration sessions. Manual results never trigger a printer command."""

import math
from decimal import Decimal
from enum import Enum
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from backend.app.core.auth import require_caller_identity_if_auth_enabled
from backend.app.core.database import get_db
from backend.app.core.identity import CallerIdentity, CallerKind
from backend.app.core.permissions import Permission
from backend.app.models.calibration import CalibrationEvidence, CalibrationSession
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.slicer_profile_catalog import (
    PrinterSlicerBinding,
    SlicerJobProvenance,
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileRevision,
)
from backend.app.services.filament_edit import FilamentCopyRequest, copy_filament_profile

router = APIRouter(prefix="/calibration", tags=["Calibration"])
ReadCaller = Annotated[CallerIdentity, Depends(require_caller_identity_if_auth_enabled(Permission.PRINTERS_READ))]
WriteCaller = Annotated[
    CallerIdentity,
    Depends(require_caller_identity_if_auth_enabled(Permission.PRINTERS_READ, Permission.SETTINGS_UPDATE)),
]


class Step(str, Enum):
    TEMPERATURE = "temperature"
    FLOW_RATE = "flow_rate"
    PRESSURE_ADVANCE = "pressure_advance"
    RETRACTION = "retraction"
    VOLUMETRIC_FLOW = "volumetric_flow"


STEPS = tuple(Step)
SETTINGS = {
    Step.TEMPERATURE: "nozzle_temperature",
    Step.FLOW_RATE: "filament_flow_ratio",
    Step.PRESSURE_ADVANCE: "pressure_advance",
    Step.RETRACTION: "filament_retraction_length",
    Step.VOLUMETRIC_FLOW: "filament_max_volumetric_speed",
}


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    printer_id: int = Field(gt=0)
    filament_profile_id: int = Field(gt=0)
    filament_revision_id: int = Field(gt=0)
    nozzle_diameter: Decimal = Field(gt=0, max_digits=4, decimal_places=2)
    tool_index: int = Field(default=0, ge=0)


class VersionedEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(gt=0)


class ResultEdit(VersionedEdit):
    value: float = Field(ge=0, allow_inf_nan=False)


class ParameterEdit(VersionedEdit):
    lowest: float = Field(ge=0, allow_inf_nan=False)
    highest: float = Field(gt=0, allow_inf_nan=False)
    increment: float = Field(gt=0, allow_inf_nan=False)
    baseline: float = Field(ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def ordered_range(self):
        if self.highest <= self.lowest:
            raise ValueError("Highest test value must exceed lowest test value")
        return self


class SaveRequest(VersionedEdit):
    name: str
    share_local_copy: bool = False


class GenerateRequest(VersionedEdit):
    binding_id: int = Field(gt=0)
    process_profile_id: int = Field(gt=0)
    acknowledge_compatibility: bool = False


class PrintRequest(VersionedEdit):
    plate_clear: Literal[True]
    use_ams: bool = False
    ams_mapping: list[Annotated[int, Field(ge=0, strict=True)]] | None = None


def personal_caller(caller: CallerIdentity) -> None:
    # API keys have printer scopes but deliberately no private row owner identity.
    if caller.kind is CallerKind.API_KEY:
        raise HTTPException(403, "Use a user login for calibration sessions")


async def load_session(db: AsyncSession, session_id: int, caller: CallerIdentity) -> CalibrationSession:
    personal_caller(caller)
    session = await db.scalar(
        select(CalibrationSession).where(
            CalibrationSession.id == session_id, CalibrationSession.owner_id == caller.owner_id
        )
    )
    if session is None:
        raise HTTPException(404, "Calibration session not found")
    caller.require_printer_access(session.printer_id)
    return session


def response(session: CalibrationSession) -> dict:
    return {
        key: getattr(session, key)
        for key in (
            "id",
            "printer_id",
            "filament_profile_id",
            "filament_revision_id",
            "tool_index",
            "parameters",
            "setting_limits",
            "results",
            "runs",
            "prints",
            "saved_profile_id",
            "version",
            "created_at",
            "updated_at",
        )
    } | {"nozzle_diameter": float(session.nozzle_diameter)}


def require_edit(session: CalibrationSession, version: int) -> None:
    if session.version != version:
        raise HTTPException(409, "Session changed in another tab; reload before editing")
    if session.saved_profile_id is not None:
        raise HTTPException(409, "This session is saved; start a new calibration to change it")


def test_request(session: CalibrationSession, step: Step) -> dict:
    index = STEPS.index(step)
    if any(previous.value not in session.results for previous in STEPS[:index]):
        raise HTTPException(409, "Record the preceding calibration results first")
    parameters = session.parameters.get(step.value)
    if parameters is None:
        raise HTTPException(409, "Save test values before generating a test")
    return {
        "step": step.value,
        **parameters,
        "previous_results": {previous.value: session.results[previous.value] for previous in STEPS[:index]},
    }


async def require_no_active_print(db: AsyncSession, session: CalibrationSession) -> None:
    if (
        session.prints
        and await db.scalar(
            select(PrintQueueItem.id).where(
                PrintQueueItem.id.in_(session.prints.values()), PrintQueueItem.status.in_(("pending", "printing"))
            )
        )
        is not None
    ):
        raise HTTPException(409, "Wait for the calibration print to finish or cancel it in the queue")


async def commit(db: AsyncSession) -> None:
    try:
        await db.commit()
    except StaleDataError as exc:
        await db.rollback()
        raise HTTPException(409, "Session changed in another tab; reload before editing") from exc


@router.post("/sessions", status_code=201)
async def create_session(body: SessionCreate, caller: WriteCaller, db: AsyncSession = Depends(get_db)):
    personal_caller(caller)
    caller.require_printer_access(body.printer_id)
    if await db.get(Printer, body.printer_id) is None:
        raise HTTPException(404, "Printer not found")
    profile = await db.scalar(
        select(SlicerProfile)
        .join(SlicerProfileAccount)
        .join(SlicerProfileActivation)
        .join(SlicerProfileRevision, SlicerProfileRevision.id == SlicerProfileActivation.revision_id)
        .where(
            SlicerProfile.id == body.filament_profile_id,
            SlicerProfile.profile_type == "filament",
            SlicerProfile.tombstoned_at.is_(None),
            SlicerProfileAccount.sync_frozen.is_(False),
            SlicerProfileRevision.id == body.filament_revision_id,
            SlicerProfileRevision.review_state == "approved",
            or_(SlicerProfileAccount.sharing_state == "shared", SlicerProfileAccount.user_id == caller.owner_id),
        )
    )
    if profile is None:
        raise HTTPException(409, "Select an available active filament revision")
    from backend.app.api.routes.slicer import resolve_orca_api_url
    from backend.app.services.slicer_api import SlicerApiError, SlicerApiService

    try:
        async with SlicerApiService(await resolve_orca_api_url(db)) as service:
            schema = await service.profile_schema("filament")
    except SlicerApiError as exc:
        raise HTTPException(503, "The configured sidecar must provide the pinned filament settings schema") from exc
    options = {option["key"]: option for option in schema.options}
    if any(key not in options for key in SETTINGS.values()):
        raise HTTPException(503, "The filament schema is missing calibration settings")
    revision = await db.get(SlicerProfileRevision, body.filament_revision_id)
    limits = {step.value: {key: options[field].get(key) for key in ("min", "max", "item_type", "units", "default")}
        for step, field in SETTINGS.items()}
    material_max = revision.content.get("nozzle_temperature_range_high", options["nozzle_temperature_range_high"]["default"])
    try:
        material_max = float(material_max[0] if isinstance(material_max, list) else material_max)
        if not 0 < material_max <= options["nozzle_temperature"]["max"]:
            raise ValueError
    except (TypeError, ValueError, IndexError) as exc:
        raise HTTPException(409, "The filament profile needs a valid maximum nozzle temperature") from exc
    limits[Step.TEMPERATURE.value]["max"] = material_max
    from backend.app.services.printer_manager import printer_manager

    snapshot = printer_manager.get_snapshot(body.printer_id)
    nozzle = next((item for item in snapshot.nozzles if item.tool_index == body.tool_index), None) if snapshot else None
    if nozzle and nozzle.max_temperature is not None:
        limits[Step.TEMPERATURE.value]["max"] = min(material_max, nozzle.max_temperature)
    session = CalibrationSession(owner_id=caller.owner_id, **body.model_dump(), parameters={}, results={},
        setting_limits=limits)
    db.add(session)
    await commit(db)
    await db.refresh(session)
    return response(session)


@router.get("/sessions")
async def list_sessions(caller: ReadCaller, db: AsyncSession = Depends(get_db)):
    personal_caller(caller)
    sessions = await db.scalars(
        select(CalibrationSession)
        .where(CalibrationSession.owner_id == caller.owner_id)
        .order_by(CalibrationSession.updated_at.desc())
    )
    return [response(session) for session in sessions]


@router.get("/sessions/{session_id}")
async def get_session(session_id: int, caller: ReadCaller, db: AsyncSession = Depends(get_db)):
    return response(await load_session(db, session_id, caller))


@router.put("/sessions/{session_id}/parameters/{step}")
async def edit_parameters(
    session_id: int, step: Step, body: ParameterEdit, caller: WriteCaller, db: AsyncSession = Depends(get_db)
):
    session = await load_session(db, session_id, caller)
    require_edit(session, body.version)
    await require_no_active_print(db, session)
    values = body.model_dump(exclude={"version"})
    for value in (body.lowest, body.highest, body.baseline):
        validate_setting(session, step, value)
    if body.increment > body.highest - body.lowest:
        raise HTTPException(422, "Step size must fit inside the test range")
    intervals = (body.highest - body.lowest) / body.increment
    if not math.isfinite(intervals):
        raise HTTPException(422, "Step size cannot represent this test range")
    last = body.lowest + round(intervals) * body.increment
    if not math.nextafter(body.highest, -math.inf) <= last <= math.nextafter(body.highest, math.inf):
        raise HTTPException(422, "Highest test value must be reached by the step size")
    if step is Step.TEMPERATURE and not body.increment.is_integer():
        raise HTTPException(422, "Temperature step size requires whole degrees")
    if session.parameters.get(step.value) != values:
        session.runs = {key: value for key, value in session.runs.items() if key != step.value}
    session.parameters = {**session.parameters, step.value: values}
    await commit(db)
    return response(session)


@router.put("/sessions/{session_id}/results/{step}")
async def edit_result(
    session_id: int, step: Step, body: ResultEdit, caller: WriteCaller, db: AsyncSession = Depends(get_db)
):
    session = await load_session(db, session_id, caller)
    require_edit(session, body.version)
    await require_no_active_print(db, session)
    validate_setting(session, step, body.value)
    index = STEPS.index(step)
    if any(previous.value not in session.results for previous in STEPS[:index]):
        raise HTTPException(409, "Record the preceding calibration results first")
    results = dict(session.results)
    if results.get(step.value) != body.value:
        for later in STEPS[index + 1 :]:
            results.pop(later.value, None)
        earlier_steps = {item.value for item in STEPS[: index + 1]}
        session.runs = {key: value for key, value in session.runs.items() if key in earlier_steps}
    session.results = {**results, step.value: body.value}
    await commit(db)
    return response(session)


def validate_setting(session: CalibrationSession, step: Step, value: float) -> None:
    limits = session.setting_limits.get(step.value)
    if limits is None:
        raise HTTPException(409, "Start a new calibration session to load its setting limits")
    if limits.get("item_type") == "int" and not value.is_integer():
        raise HTTPException(422, "This setting requires a whole number")
    if value < max(0, limits.get("min") or 0) or (limits.get("max") is not None and value > limits["max"]):
        raise HTTPException(422, "Value is outside this filament setting's limits")
    if value == 0 and step not in {Step.PRESSURE_ADVANCE, Step.RETRACTION}:
        raise HTTPException(422, "This setting must be greater than zero")


def require_temperature_capacity(session: CalibrationSession, step: Step, nozzle) -> None:
    if nozzle is None or nozzle.max_temperature is None:
        return
    temperatures = (session.parameters[step.value]["highest"], session.parameters[step.value]["baseline"]) if step is Step.TEMPERATURE else (session.results[Step.TEMPERATURE.value],)
    if max(temperatures) > nozzle.max_temperature:
        raise HTTPException(409, "Calibration exceeds the printer's reported nozzle temperature limit")


@router.post("/sessions/{session_id}/save")
async def save_session(session_id: int, body: SaveRequest, caller: WriteCaller, db: AsyncSession = Depends(get_db)):
    session = await load_session(db, session_id, caller)
    if session.saved_profile_id is not None:
        return response(session)
    require_edit(session, body.version)
    await require_no_active_print(db, session)
    if any(step.value not in session.results for step in STEPS):
        raise HTTPException(409, "Record all five calibration results before saving")
    temperature = session.results[Step.TEMPERATURE.value]
    if not temperature.is_integer():
        raise HTTPException(422, "Orca nozzle temperature requires whole degrees")
    overrides = {SETTINGS[step]: [format(session.results[step.value], ".15g")] for step in STEPS}
    overrides["nozzle_temperature_initial_layer"] = overrides["nozzle_temperature"]
    overrides["enable_pressure_advance"] = ["1"]
    saved = await copy_filament_profile(
        db,
        session.filament_profile_id,
        FilamentCopyRequest(
            base_revision_id=session.filament_revision_id,
            name=body.name,
            overrides=overrides,
            share_local_copy=body.share_local_copy,
        ),
        caller.owner_id,
    )
    session.saved_profile_id = saved["profile_id"]
    await commit(db)
    return response(session)


@router.post("/sessions/{session_id}/generate/{step}")
async def generate_test(
    session_id: int, step: Step, body: GenerateRequest, caller: WriteCaller, db: AsyncSession = Depends(get_db)
):
    from backend.app.api.routes.library import slice_and_persist
    from backend.app.api.routes.slicer import resolve_orca_api_url
    from backend.app.core.database import async_session
    from backend.app.schemas.slicer import SliceRequest
    from backend.app.services.slice_dispatch import http_exception_to_job_error, slice_dispatch
    from backend.app.services.slicer_api import SlicerApiError, SlicerApiService
    from backend.app.services.slicer_catalog_selection import CatalogSelectionError, persist_catalog_selection

    session = await load_session(db, session_id, caller)
    require_edit(session, body.version)
    await require_no_active_print(db, session)
    calibration = test_request(session, step)
    from backend.app.services.printer_manager import printer_manager

    snapshot = printer_manager.get_snapshot(session.printer_id)
    nozzle = next((item for item in snapshot.nozzles if item.tool_index == session.tool_index), None) if snapshot else None
    require_temperature_capacity(session, step, nozzle)
    binding = await db.get(PrinterSlicerBinding, body.binding_id)
    if (
        binding is None
        or binding.printer_id != session.printer_id
        or binding.tool_index != session.tool_index
        or binding.expected_nozzle_diameter != session.nozzle_diameter
        or session.tool_index != 0
    ):
        raise HTTPException(409, "Choose the installed single-extruder binding for this printer and nozzle")
    try:
        async with SlicerApiService(await resolve_orca_api_url(db)) as service:
            capabilities = await service.capabilities()
            if (
                not capabilities.calibration
                or capabilities.calibration.get("available") is not True
                or capabilities.calibration.get("version") != "1"
            ):
                raise HTTPException(503, "The configured Orca sidecar does not have the calibration engine")
    except SlicerApiError as exc:
        raise HTTPException(503, str(exc)) from exc
    rows = (await db.execute(select(SlicerProfile.profile_type, SlicerProfile.remote_profile_id, SlicerProfileAccount.source)
        .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
        .where(SlicerProfile.id.in_((binding.profile_id, body.process_profile_id, session.filament_profile_id))))).all()
    refs = {kind: {"source": source, "id": remote_id} for kind, remote_id, source in rows}
    if set(refs) != {"printer", "process", "filament"}:
        raise HTTPException(409, "Choose an available printer, process, and filament profile")
    request = SliceRequest(
        printer_preset=refs["printer"], process_preset=refs["process"], filament_preset=refs["filament"],
        catalog_printer_id=session.printer_id,
        catalog_binding_id=binding.id,
        catalog_process_profile_id=body.process_profile_id,
        catalog_filament_profile_ids=[session.filament_profile_id],
        arrange=True,
        schema_hash=capabilities.schema_hash,
        catalog_acknowledgement={"confirmed": True} if body.acknowledge_compatibility else None,
    )

    async def prepare(job_db, job):
        current = await load_session(job_db, session_id, caller)
        require_edit(current, body.version)
        previous_job_id = current.runs.get(step.value)
        if previous_job_id:
            previous_job = await job_db.get(SliceJobRecord, previous_job_id)
            if previous_job and previous_job.status in {"pending", "running", "cancel-requested"}:
                raise HTTPException(409, "This test is already being generated")
        await persist_catalog_selection(job_db, job, request, force_validation=True)
        provenance = await job_db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
        if provenance.filament_revision_ids != [current.filament_revision_id]:
            raise HTTPException(409, "The filament revision changed; start a new calibration session")
        job.request_snapshot = {**job.request_snapshot, "calibration": calibration}
        current.runs = {**current.runs, step.value: job.id}

    async def run(job_id):
        async with async_session() as job_db:
            try:
                result = await slice_and_persist(
                    job_db,
                    model_bytes=b"",
                    model_filename=f"{step.value}-calibration.drc",
                    folder_id=None,
                    extra_metadata={"calibration_session_id": session_id, "calibration_step": step.value},
                    request=request,
                    current_user_id=caller.owner_id,
                    job_id=job_id,
                    calibration=calibration,
                )
                return result.model_dump(mode="json")
            except HTTPException as exc:
                raise http_exception_to_job_error(exc) from exc

    try:
        await slice_dispatch.enqueue(
            kind="calibration_session",
            source_id=session_id,
            source_name=f"{step.value} calibration",
            run=run,
            owner_id=caller.owner_id,
            schema_hash=capabilities.schema_hash,
            request_snapshot=request.model_dump(mode="json"),
            before_commit=prepare,
        )
    except CatalogSelectionError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "reason_codes": exc.reason_codes}) from exc
    except StaleDataError as exc:
        raise HTTPException(409, "Session changed; reload before generating") from exc
    await db.refresh(session)
    return response(session)


@router.post("/sessions/{session_id}/print/{step}")
async def print_test(
    session_id: int, step: Step, body: PrintRequest, caller: WriteCaller, db: AsyncSession = Depends(get_db)
):
    from backend.app.api.routes.print_queue import enqueue_print
    from backend.app.schemas.print_queue import PrintQueueItemCreate
    from backend.app.services.printer_manager import printer_manager

    caller.require_permissions(Permission.QUEUE_CREATE, Permission.PRINTERS_CLEAR_PLATE)
    session = await load_session(db, session_id, caller)
    require_edit(session, body.version)
    await require_no_active_print(db, session)
    job_id = session.runs.get(step.value)
    job = await db.get(SliceJobRecord, job_id) if job_id else None
    if job is None or job.status != "completed" or job.result_artifact_kind != "library_file":
        raise HTTPException(409, "Generate this calibration test before printing")
    if job.request_snapshot.get("calibration") != test_request(session, step):
        raise HTTPException(409, "Test values or preceding results changed; generate the test again")
    if not printer_manager.is_connected(session.printer_id):
        raise HTTPException(409, "Connect the printer before printing a calibration test")
    snapshot = printer_manager.get_snapshot(session.printer_id)
    if snapshot is None or snapshot.telemetry_stale or not snapshot.connected:
        raise HTTPException(409, "Wait for current printer telemetry before printing")
    from backend.app.services.printer_types import NormalizedPrinterState

    if snapshot.state not in {
        NormalizedPrinterState.IDLE,
        NormalizedPrinterState.COMPLETED,
        NormalizedPrinterState.CANCELLED,
    }:
        raise HTTPException(409, "Wait until the printer is ready before starting a calibration test")
    nozzle = next((item for item in snapshot.nozzles if item.tool_index == session.tool_index), None)
    if (
        nozzle is None
        or nozzle.status != "confirmed"
        or nozzle.diameter is None
        or Decimal(str(nozzle.diameter)) != session.nozzle_diameter
    ):
        raise HTTPException(409, "Confirm that the installed nozzle matches this calibration")
    require_temperature_capacity(session, step, nozzle)
    if body.use_ams:
        from backend.app.services.printer_types import PrinterProvider

        if snapshot.provider is not PrinterProvider.BAMBU or not body.ams_mapping or len(body.ams_mapping) != 1:
            raise HTTPException(422, "Select one loaded AMS slot on a Bambu printer")
        state = printer_manager.get_bambu_state(session.printer_id)
        revision = await db.get(SlicerProfileRevision, session.filament_revision_id)
        material = revision.content.get("filament_type", [])
        material = material[0] if isinstance(material, list) and material else material
        matching_tray = None
        units = state.raw_data.get("ams", []) if state else []
        if isinstance(units, dict):
            units = units.get("ams", [])
        for unit in units if isinstance(units, list) else []:
            if not isinstance(unit, dict):
                continue
            trays = unit.get("tray", [])
            for tray in trays if isinstance(trays, list) else []:
                if not isinstance(tray, dict):
                    continue
                try:
                    unit_id, tray_id = int(unit["id"]), int(tray["id"])
                    if unit_id < 0 or unit_id == 255 or tray_id < 0:
                        continue
                    slot_id = unit_id if unit_id >= 128 else unit_id * 4 + tray_id
                    empty = int(tray.get("state", 0)) == 9
                except (KeyError, TypeError, ValueError):
                    continue
                if slot_id == body.ams_mapping[0] and not empty:
                    matching_tray = tray
        if not material or matching_tray is None or str(matching_tray.get("tray_type", "")).casefold() != str(material).casefold():
            raise HTTPException(409, "Load the calibrated filament type in the selected AMS slot")
    elif body.ams_mapping is not None:
        raise HTTPException(422, "AMS mapping requires AMS printing")
    pending = await db.scalar(
        select(PrintQueueItem.id).where(
            PrintQueueItem.printer_id == session.printer_id, PrintQueueItem.status.in_(("pending", "printing"))
        )
    )
    if pending is not None:
        raise HTTPException(409, "Finish this printer's queue before starting calibration")

    async def associate(items):
        session.prints = {**session.prints, step.value: items[0].id}

    try:
        await enqueue_print(
            PrintQueueItemCreate(
                printer_id=session.printer_id,
                library_file_id=job.result_artifact_id,
                use_ams=body.use_ams,
                ams_mapping=body.ams_mapping,
                flow_cali=False,
                vibration_cali=False,
            ),
            db,
            caller,
            before_commit=associate,
        )
    except StaleDataError as exc:
        await db.rollback()
        raise HTTPException(409, "Session changed; reload before printing") from exc
    printer_manager.set_awaiting_plate_clear(session.printer_id, False)
    await db.refresh(session)
    return response(session)


def evidence_response(evidence: CalibrationEvidence) -> dict:
    return {
        key: getattr(evidence, key)
        for key in ("id", "session_id", "step", "source", "run_id", "print_id", "created_at")
    }


@router.get("/sessions/{session_id}/evidence")
async def list_evidence(session_id: int, caller: ReadCaller, db: AsyncSession = Depends(get_db)):
    await load_session(db, session_id, caller)
    rows = await db.scalars(
        select(CalibrationEvidence)
        .where(CalibrationEvidence.session_id == session_id)
        .order_by(CalibrationEvidence.created_at.desc(), CalibrationEvidence.id.desc())
    )
    return [evidence_response(row) for row in rows]


@router.post("/sessions/{session_id}/evidence/{step}", status_code=201)
async def upload_evidence(
    session_id: int,
    step: Step,
    caller: WriteCaller,
    file: UploadFile = File(...),
    source: Literal["upload", "camera"] = Form("upload"),
    db: AsyncSession = Depends(get_db),
):
    import uuid
    import warnings

    from PIL import Image, ImageOps, UnidentifiedImageError
    from starlette.concurrency import run_in_threadpool

    from backend.app.core.config import settings
    from backend.app.core.image_limits import MAX_IMAGE_UPLOAD_BYTES

    session = await load_session(db, session_id, caller)
    if file.size is None or file.size > MAX_IMAGE_UPLOAD_BYTES:
        raise HTTPException(413, "Calibration photo exceeds size limit")
    if session.saved_profile_id:
        raise HTTPException(409, "This calibration session is already saved")
    directory = settings.base_dir / "calibration" / str(session.id)
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.png"
    path = directory / filename

    def store_photo():
        # Decode a spooled upload, enforce Pillow's pixel safety, and persist only image pixels.
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(file.file) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("Use a JPEG, PNG, or WebP photo")
                image.load()
                oriented = ImageOps.exif_transpose(image)
                clean = Image.new("RGB", oriented.size)
                clean.paste(oriented.convert("RGB"))
                clean.save(path, format="PNG", optimize=True)
                if path.stat().st_size > MAX_IMAGE_UPLOAD_BYTES:
                    raise ValueError("Normalized photo exceeds the image size limit")

    try:
        await run_in_threadpool(store_photo)
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(422, "Use a valid JPEG, PNG, or WebP photo") from exc
    row = CalibrationEvidence(
        session_id=session.id,
        step=step.value,
        source=source,
        filename=filename,
        run_id=session.runs.get(step.value),
        print_id=session.prints.get(step.value),
    )
    db.add(row)
    try:
        await db.commit()
        await db.refresh(row)
    except Exception:
        await db.rollback()
        path.unlink(missing_ok=True)
        raise
    return evidence_response(row)


@router.get("/sessions/{session_id}/evidence/{evidence_id}/image")
async def evidence_image(session_id: int, evidence_id: int, caller: ReadCaller, db: AsyncSession = Depends(get_db)):
    import re

    from fastapi.responses import FileResponse

    from backend.app.core.config import settings

    await load_session(db, session_id, caller)
    row = await db.scalar(
        select(CalibrationEvidence).where(
            CalibrationEvidence.id == evidence_id, CalibrationEvidence.session_id == session_id
        )
    )
    if row is None or not re.fullmatch(r"[0-9a-f]{32}\.png", row.filename):
        raise HTTPException(404, "Calibration photo not found")
    path = settings.base_dir / "calibration" / str(session_id) / row.filename
    if not path.is_file():
        raise HTTPException(404, "Calibration photo not found")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, no-store"})
