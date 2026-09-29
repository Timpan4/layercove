"""HTTP client for an OrcaSlicer / BambuStudio API sidecar.

Bambuddy stores user printer/process/filament profiles itself (cloud-synced
or locally imported), so the slice flow always sends the model file plus an
explicit JSON profile triplet to the sidecar's `/slice` endpoint. The sidecar
shape follows the standalone API at https://github.com/Timpan4/orca-slicer-api
(multipart upload, `--load-settings` under the hood, response body is raw G-code
or 3MF with metadata in the `X-Print-Time-Seconds` / `X-Filament-Used-G` /
`X-Filament-Used-Mm` headers).
"""

import asyncio
import hashlib
import json
import logging
import time
from collections.abc import Callable
from typing import NamedTuple

import httpx
from pydantic import ValidationError

from backend.app.schemas.slicer_contract import (
    ORCA_COMMIT,
    ORCA_CONTRACT_VERSION,
    ORCA_VERSION,
    SlicerCapabilitiesResponse,
    SlicerProcessSchemaResponse,
)

logger = logging.getLogger(__name__)


class SlicerApiError(Exception):
    """Base error from the slicer API sidecar."""


class SlicerApiUnavailableError(SlicerApiError):
    """Sidecar is unreachable (connection error, no response)."""


class SlicerApiServerError(SlicerApiError):
    """Sidecar responded with a 5xx — usually the wrapped slicer CLI exited
    non-zero (range-validation reject, segfault on complex models, etc.).
    Distinguished from `SlicerApiUnavailableError` so the caller can decide
    whether to retry with a different request shape (e.g. a 3MF embedded-
    settings fallback)."""


class SlicerInputError(SlicerApiError):
    """Sidecar rejected the input as invalid (4xx)."""


class SlicerSchemaMismatchError(SlicerApiError):
    """Sidecar identity or process schema differs from the pinned contract."""


class SliceResult(NamedTuple):
    """Result of a slice operation."""

    content: bytes
    print_time_seconds: int
    filament_used_g: float
    filament_used_mm: float


_shared_http_client: httpx.AsyncClient | None = None
_CAPABILITIES_TTL_SECONDS = 30.0
_MAX_CONTRACT_BYTES = 8 * 1024 * 1024
_BED_TYPE_PROFILE_KEY = "curr_bed_type"
_capabilities_cache: dict[str, tuple[float, SlicerCapabilitiesResponse]] = {}
_schema_cache: dict[tuple[str, str, str], SlicerProcessSchemaResponse] = {}


def _process_schema_hash(schema: SlicerProcessSchemaResponse) -> str:
    payload = schema.model_dump(mode="json", include={"pages", "options", "scopes", "samples"})
    normalized = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    return hashlib.sha256(normalized).hexdigest()


def _validate_contract_identity(contract: SlicerCapabilitiesResponse) -> None:
    if (
        contract.contract_version != ORCA_CONTRACT_VERSION
        or contract.engine.version != ORCA_VERSION
        or contract.engine.commit != ORCA_COMMIT
    ):
        raise SlicerSchemaMismatchError(
            "Pinned slicer contract mismatch: expected "
            f"contract {ORCA_CONTRACT_VERSION}, Orca {ORCA_VERSION} ({ORCA_COMMIT}); got "
            f"contract {contract.contract_version}, Orca {contract.engine.version} ({contract.engine.commit})"
        )


def _format_sidecar_error(response: httpx.Response) -> str:
    """Build a human-readable error string from a sidecar 4xx/5xx response.

    The sidecar's `AppError` middleware emits a JSON body of the shape
    ``{"message": "...", "details": "..."}``. Earlier versions of this
    client only read ``message``, which left every CLI failure surfaced
    as the generic ``Failed to slice the model`` because the *actual*
    CLI stderr / `error_string` lives in ``details``. Including both
    means ``bambuddy.log`` carries the real reason a slice rejected
    the supplied profiles instead of an unhelpful generic line.
    """
    try:
        payload = response.json()
    except Exception:
        return response.text[:500]
    if not isinstance(payload, dict):
        return str(payload)[:500]
    message = payload.get("message") or ""
    details = payload.get("details") or ""
    if message and details:
        return f"{message}: {details}"[:500]
    return (message or details or response.text)[:500]


def set_shared_http_client(client: httpx.AsyncClient | None) -> None:
    """Register an app-scoped client so per-request services can pool transport."""
    global _shared_http_client
    _shared_http_client = client


def _guess_model_content_type(filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".stl"):
        return "model/stl"
    if lower.endswith(".3mf") or lower.endswith(".gcode.3mf"):
        return "model/3mf"
    if lower.endswith(".step") or lower.endswith(".stp"):
        return "model/step"
    return "application/octet-stream"


class SlicerApiService:
    """Talks to an OrcaSlicer / BambuStudio API sidecar."""

    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 300.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        if client is not None:
            self._client = client
            self._owns_client = False
        elif _shared_http_client is not None:
            self._client = _shared_http_client
            self._owns_client = False
        else:
            self._client = httpx.AsyncClient(timeout=timeout_seconds)
            self._owns_client = True

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> "SlicerApiService":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def health(self) -> dict:
        """GET /health — used to surface a clear "sidecar offline" error before
        accepting a slice request from the user."""
        try:
            response = await self._client.get(f"{self.base_url}/health", timeout=10.0)
        except httpx.RequestError as exc:
            raise SlicerApiUnavailableError(f"Slicer sidecar unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise SlicerApiUnavailableError(f"Slicer sidecar /health returned {response.status_code}")
        return response.json()

    async def capabilities(self, *, refresh: bool = False) -> SlicerCapabilitiesResponse:
        cached = _capabilities_cache.get(self.base_url)
        now = time.monotonic()
        if not refresh and cached is not None and cached[0] > now:
            return cached[1]
        payload = await self._get_contract_json("/capabilities")
        try:
            contract = SlicerCapabilitiesResponse.model_validate(payload)
        except ValidationError as exc:
            raise SlicerSchemaMismatchError(f"Invalid slicer capability contract: {exc}") from exc
        _validate_contract_identity(contract)
        _capabilities_cache[self.base_url] = (now + _CAPABILITIES_TTL_SECONDS, contract)
        return contract

    async def process_schema(self, *, refresh: bool = False) -> SlicerProcessSchemaResponse:
        capabilities = await self.capabilities(refresh=refresh)
        key = (self.base_url, capabilities.engine.commit, capabilities.schema_hash)
        if not refresh and key in _schema_cache:
            return _schema_cache[key]
        payload = await self._get_contract_json("/schema/process")
        try:
            schema = SlicerProcessSchemaResponse.model_validate(payload)
        except ValidationError as exc:
            raise SlicerSchemaMismatchError(f"Invalid slicer process schema: {exc}") from exc
        _validate_contract_identity(schema)
        if schema.schema_hash != capabilities.schema_hash:
            raise SlicerSchemaMismatchError(
                f"Slicer schema hash changed during discovery: {capabilities.schema_hash} != {schema.schema_hash}"
            )
        content_hash = _process_schema_hash(schema)
        if content_hash != schema.schema_hash:
            raise SlicerSchemaMismatchError(
                f"Slicer schema content hash mismatch: declared {schema.schema_hash}, computed {content_hash}"
            )
        _schema_cache[key] = schema
        return schema

    async def validate_workbench_request(
        self,
        *,
        schema_hash: str,
        process_overrides: dict,
        model_state: dict | None,
    ) -> None:
        schema = await self.process_schema()
        if schema.schema_hash != schema_hash:
            raise SlicerSchemaMismatchError(
                f"Browser schema {schema_hash} does not match sidecar schema {schema.schema_hash}"
            )

        options = {
            option.get("key"): option
            for option in schema.options
            if isinstance(option, dict) and isinstance(option.get("key"), str)
        }
        self._validate_override_scope(process_overrides, options, schema.scopes, "global")
        if model_state is not None and not (await self.capabilities()).capabilities.model_state:
            raise SlicerInputError("Slicer sidecar does not support model_state")
        if model_state is not None:
            for obj in model_state.get("objects", []):
                if isinstance(obj, dict):
                    overrides = obj.get("overrides") or {}
                    if isinstance(overrides, dict):
                        self._validate_override_scope(overrides, options, schema.scopes, "object")

    @staticmethod
    def _validate_override_scope(
        overrides: dict,
        options: dict[str, dict],
        scopes: dict[str, str | list[str]],
        required_scope: str,
    ) -> None:
        for key, value in overrides.items():
            option = options.get(key)
            if option is None:
                if key == _BED_TYPE_PROFILE_KEY and required_scope == "global":
                    if not isinstance(value, str):
                        raise SlicerInputError(f"Process setting {key} must be a string")
                    continue
                raise SlicerInputError(f"Unknown process setting: {key}")
            allowed = scopes.get(key, [])
            allowed_scopes = [allowed] if isinstance(allowed, str) else allowed
            if required_scope not in allowed_scopes:
                raise SlicerInputError(f"Process setting {key} does not support {required_scope} scope")
            value_type = option.get("type")
            if value_type in ("bool", "boolean") and not isinstance(value, bool):
                raise SlicerInputError(f"Process setting {key} must be boolean")
            if value_type in ("int", "integer") and (not isinstance(value, int) or isinstance(value, bool)):
                raise SlicerInputError(f"Process setting {key} must be an integer")
            if value_type in ("float", "number", "percent") and (
                not isinstance(value, (int, float)) or isinstance(value, bool)
            ):
                raise SlicerInputError(f"Process setting {key} must be numeric")
            if value_type in ("string", "enum") and not isinstance(value, str):
                raise SlicerInputError(f"Process setting {key} must be a string")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                minimum = option.get("min", option.get("minimum"))
                maximum = option.get("max", option.get("maximum"))
                if minimum is not None and value < minimum:
                    raise SlicerInputError(f"Process setting {key} is below its minimum")
                if maximum is not None and value > maximum:
                    raise SlicerInputError(f"Process setting {key} is above its maximum")
            choices = option.get("choices", option.get("enum"))
            if isinstance(choices, list) and value not in choices:
                raise SlicerInputError(f"Process setting {key} is not an allowed choice")

    async def cancel_slice(self, request_id: str) -> None:
        capabilities = await self.capabilities()
        if not capabilities.capabilities.cancel:
            raise SlicerInputError("Slicer sidecar does not support cancellation")
        try:
            response = await self._client.post(f"{self.base_url}/slice/cancel/{request_id}", timeout=10.0)
        except httpx.RequestError as exc:
            raise SlicerApiUnavailableError(f"Slicer sidecar unreachable: {exc}") from exc
        if response.status_code >= 500:
            raise SlicerApiServerError(
                f"Slicer cancel failed ({response.status_code}): {_format_sidecar_error(response)}"
            )
        if response.status_code >= 400:
            raise SlicerInputError(
                f"Slicer cancel rejected ({response.status_code}): {_format_sidecar_error(response)}"
            )

    async def _get_contract_json(self, path: str) -> dict:
        try:
            async with self._client.stream("GET", f"{self.base_url}{path}", timeout=10.0) as response:
                if response.status_code >= 500:
                    raise SlicerApiServerError(f"Slicer sidecar {path} failed ({response.status_code})")
                if response.status_code >= 400:
                    raise SlicerSchemaMismatchError(f"Slicer sidecar does not provide required {path} contract")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > _MAX_CONTRACT_BYTES:
                        raise SlicerSchemaMismatchError(
                            f"Slicer sidecar {path} contract exceeds {_MAX_CONTRACT_BYTES} bytes"
                        )
                    body.extend(chunk)
        except httpx.RequestError as exc:
            raise SlicerApiUnavailableError(f"Slicer sidecar unreachable: {exc}") from exc
        try:
            payload = json.loads(body)
        except (ValueError, RecursionError) as exc:
            raise SlicerSchemaMismatchError(f"Slicer sidecar {path} returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise SlicerSchemaMismatchError(f"Slicer sidecar {path} must return a JSON object")
        return payload

    async def list_bundled_profiles(self) -> dict:
        """GET /profiles/bundled — return the full standard-profile snapshot.

        The sidecar returns ``{printer, process, filament}`` arrays. Each entry
        includes a stable id (or content hash), resolved full ``content``, and
        authoritative metadata such as ``compatible_printers``.

        Returns an empty-shaped dict when the sidecar is unreachable so the
        unified-presets endpoint can degrade to "no standard tier" without
        crashing the modal — cloud + local-imported profiles still render.
        """
        try:
            response = await self._client.get(f"{self.base_url}/profiles/bundled", timeout=10.0)
        except httpx.RequestError as exc:
            raise SlicerApiUnavailableError(f"Slicer sidecar unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise SlicerApiUnavailableError(f"Slicer sidecar /profiles/bundled returned {response.status_code}")
        return response.json()

    async def _poll_progress(
        self,
        request_id: str,
        on_progress: Callable[[dict], None],
    ) -> None:
        """Poll the sidecar's progress endpoint at ~1Hz and forward each
        snapshot to ``on_progress``. Runs until cancelled.

        4xx is NOT treated as terminal: the FIRST poll fires the moment
        the slice POST is sent, which can be milliseconds before the
        request actually lands on the sidecar and `progressStore.start()`
        runs — so a fresh request legitimately returns 404 for the first
        tick or two. Bailing on the first 404 (the original implementation)
        meant we'd quit before progress could ever arrive. The polling
        task is cancelled by the outer slice request anyway, so a
        sustained 404 (older sidecar without progress support, or post-
        slice grace expiry) just costs a few wasted GETs that the cancel
        will stop. Network errors and non-JSON 5xx are swallowed; the
        next tick retries.
        """
        url = f"{self.base_url}/slice/progress/{request_id}"
        while True:
            try:
                response = await self._client.get(url, timeout=5.0)
                if response.status_code == 200:
                    payload = response.json()
                    if isinstance(payload, dict):
                        on_progress(payload)
                # 404 / other 4xx = no progress available (yet, or ever
                # for older sidecars). Keep polling — the outer slice
                # request will cancel this task on completion.
            except (httpx.RequestError, ValueError):
                # ValueError covers JSONDecodeError when the sidecar
                # returns a non-JSON 5xx. Don't crash the poller.
                pass
            try:
                await asyncio.sleep(1.0)
            except asyncio.CancelledError:
                return

    async def slice_with_profiles(
        self,
        *,
        model_bytes: bytes,
        model_filename: str,
        printer_profile_json: str,
        process_profile_json: str,
        filament_profile_jsons: list[str],
        process_overrides: dict | None = None,
        plate: int | None = None,
        export_3mf: bool = False,
        arrange: bool = False,
        schema_hash: str | None = None,
        model_state: dict | None = None,
        request_id: str | None = None,
        on_progress: Callable[[dict], None] | None = None,
    ) -> SliceResult:
        """POST /slice with model + printer/process/filament profiles.

        ``filament_profile_jsons`` is plate-slot-ordered: index 0 is the
        profile for slot 1, etc. Single-color callers pass a one-element
        list. Multiple ``filamentProfile`` parts are sent as a repeated form
        field — the sidecar's route declares ``maxCount: 16`` and the
        slicing service joins them as semicolon-separated
        ``--load-filaments`` for the OrcaSlicer / BambuStudio CLI.

        ``arrange`` forwards the sidecar's ``--arrange`` flag to BambuStudio.
        When True the slicer auto-repositions objects on the target bed,
        which Bambuddy uses for cross-nozzle-class re-slices (#1493) where
        the source's X1C-coordinate layout would otherwise drop into an H2D
        dead zone or trigger the multi-extruder geometry pipeline's polygon
        clipping crash. Default off so single-printer slices preserve the
        user's deliberate layout.

        ``request_id``: when supplied, the sidecar wires --pipe to a
        per-request FIFO and publishes structured JSON progress events to
        its in-memory ProgressStore under this id. Bambuddy's slice
        dispatch polls ``GET /slice/progress/{request_id}`` in parallel
        to drive the live-progress toast.

        Raises:
            SlicerInputError: 4xx from sidecar (caller-supplied input is bad).
            SlicerApiUnavailableError: connection error or 5xx from sidecar.
        """
        # httpx supports repeated multipart fields when files is a list of
        # tuples — using the dict form would silently overwrite duplicate
        # keys and ship only the last filament profile.
        files: list[tuple[str, tuple[str, bytes, str]]] = [
            ("file", (model_filename, model_bytes, _guess_model_content_type(model_filename))),
            ("printerProfile", ("printer.json", printer_profile_json.encode("utf-8"), "application/json")),
            ("presetProfile", ("preset.json", process_profile_json.encode("utf-8"), "application/json")),
        ]
        for idx, fjson in enumerate(filament_profile_jsons):
            files.append(
                (
                    "filamentProfile",
                    (f"filament_{idx + 1}.json", fjson.encode("utf-8"), "application/json"),
                )
            )

        data: dict[str, str] = {}
        if process_overrides:
            data["processOverrides"] = json.dumps(process_overrides, separators=(",", ":"))
        if plate is not None:
            data["plate"] = str(plate)
        if export_3mf:
            data["exportType"] = "3mf"
        if arrange:
            data["arrange"] = "true"
        if schema_hash is not None:
            data["schemaHash"] = schema_hash
        if model_state is not None:
            data["modelState"] = json.dumps(model_state, separators=(",", ":"))
        if request_id is not None:
            data["requestId"] = request_id

        # When the caller supplied a request_id, kick off a parallel
        # poller that reads the sidecar's --pipe-fed progress endpoint
        # and surfaces structured updates via on_progress. Uses a
        # short-tick poll (1s) since the slicer emits stage changes
        # several times per minute on complex models.
        progress_task: asyncio.Task | None = None
        if request_id is not None and on_progress is not None:
            progress_task = asyncio.create_task(
                self._poll_progress(request_id, on_progress),
                name=f"slicer-progress-{request_id}",
            )

        try:
            response = await self._client.post(
                f"{self.base_url}/slice",
                files=files,
                data=data,
                timeout=self.timeout_seconds,
            )
        except httpx.RequestError as exc:
            raise SlicerApiUnavailableError(f"Slicer sidecar unreachable: {exc}") from exc
        finally:
            if progress_task is not None:
                progress_task.cancel()
                try:
                    await progress_task
                except (asyncio.CancelledError, Exception):
                    pass  # Polling errors must not fail the slice.

        if response.status_code >= 500:
            raise SlicerApiServerError(f"Slicer CLI failed ({response.status_code}): {_format_sidecar_error(response)}")
        if response.status_code >= 400:
            raise SlicerInputError(f"Slicer rejected input ({response.status_code}): {_format_sidecar_error(response)}")

        return SliceResult(
            content=response.content,
            print_time_seconds=_safe_int(response.headers.get("x-print-time-seconds")),
            filament_used_g=_safe_float(response.headers.get("x-filament-used-g")),
            filament_used_mm=_safe_float(response.headers.get("x-filament-used-mm")),
        )

    async def slice_without_profiles(
        self,
        *,
        model_bytes: bytes,
        model_filename: str,
        plate: int | None = None,
        export_3mf: bool = False,
        request_id: str | None = None,
        on_progress: Callable[[dict], None] | None = None,
    ) -> SliceResult:
        """POST /slice with only the model file and no profile triplet.

        For 3MF inputs this lets the slicer fall back on the file's embedded
        `Metadata/project_settings.config`. Used as a fallback when
        `slice_with_profiles` triggers a CLI segfault or other 5xx —
        complex H2D / multi-extruder models hit upstream bugs in both the
        OrcaSlicer and BambuStudio CLIs when invoked via `--load-settings`.

        Also used by the SliceModal's per-plate filament discovery path:
        for an unsliced project file we run a real preview slice via the
        sidecar to find which AMS slots the picked plate consumes. The
        ``request_id`` parameter routes the sidecar's --pipe progress
        events to the ProgressStore so the modal's inline spinner +
        toast can show "Generating G-code (75%)" for that preview as
        well.
        """
        files = {
            "file": (model_filename, model_bytes, _guess_model_content_type(model_filename)),
        }
        data: dict[str, str] = {}
        if plate is not None:
            data["plate"] = str(plate)
        if export_3mf:
            data["exportType"] = "3mf"
        if request_id is not None:
            data["requestId"] = request_id

        # Same progress-poller wiring as slice_with_profiles. Used by the
        # SliceModal's preview slice (for filament discovery) AND the
        # embedded-settings fallback path triggered by an Orca/Bambu CLI
        # segfault on complex H2D models — both want to keep updating
        # the user's toast through the slow operation.
        progress_task: asyncio.Task | None = None
        if request_id is not None and on_progress is not None:
            progress_task = asyncio.create_task(
                self._poll_progress(request_id, on_progress),
                name=f"slicer-progress-{request_id}",
            )

        try:
            response = await self._client.post(
                f"{self.base_url}/slice",
                files=files,
                data=data,
                timeout=self.timeout_seconds,
            )
        except httpx.RequestError as exc:
            raise SlicerApiUnavailableError(f"Slicer sidecar unreachable: {exc}") from exc
        finally:
            if progress_task is not None:
                progress_task.cancel()
                try:
                    await progress_task
                except (asyncio.CancelledError, Exception):
                    pass

        if response.status_code >= 500:
            raise SlicerApiServerError(f"Slicer CLI failed ({response.status_code}): {_format_sidecar_error(response)}")
        if response.status_code >= 400:
            raise SlicerInputError(f"Slicer rejected input ({response.status_code}): {_format_sidecar_error(response)}")

        return SliceResult(
            content=response.content,
            print_time_seconds=_safe_int(response.headers.get("x-print-time-seconds")),
            filament_used_g=_safe_float(response.headers.get("x-filament-used-g")),
            filament_used_mm=_safe_float(response.headers.get("x-filament-used-mm")),
        )


def _safe_int(value: str | None) -> int:
    if not value:
        return 0
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _safe_float(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
