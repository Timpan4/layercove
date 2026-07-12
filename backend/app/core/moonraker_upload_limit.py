"""Ingress body limit for Moonraker multipart uploads."""

from starlette.responses import JSONResponse

from backend.app.services.moonraker_http import MOONRAKER_MAX_UPLOAD_BYTES

_MULTIPART_OVERHEAD_BYTES = 1024 * 1024
MOONRAKER_MAX_UPLOAD_BODY_BYTES = MOONRAKER_MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD_BYTES


class _UploadBodyTooLarge(Exception):
    pass


class MoonrakerUploadBodyLimitMiddleware:
    """Stop oversized upload bodies at ASGI receive, before multipart spooling."""

    def __init__(self, app, *, max_body_bytes: int = MOONRAKER_MAX_UPLOAD_BODY_BYTES):
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope, receive, send):
        if not self._applies(scope):
            await self.app(scope, receive, send)
            return

        content_length = self._content_length(scope)
        if content_length is not None and content_length > self.max_body_bytes:
            await self._reject(scope, receive, send)
            return

        received = 0
        response_started = False

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body_bytes:
                    raise _UploadBodyTooLarge
            return message

        async def tracked_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except _UploadBodyTooLarge:
            if response_started:
                raise
            await self._reject(scope, receive, send)

    @staticmethod
    def _applies(scope) -> bool:
        return (
            scope["type"] == "http"
            and scope.get("method") == "POST"
            and scope.get("path", "").startswith("/api/")
            and scope.get("path", "").endswith("/moonraker/upload-gcode")
        )

    @staticmethod
    def _content_length(scope) -> int | None:
        for name, value in scope.get("headers", ()):
            if name.lower() == b"content-length":
                try:
                    return int(value)
                except ValueError:
                    return None
        return None

    @staticmethod
    async def _reject(scope, receive, send) -> None:
        response = JSONResponse(
            status_code=413,
            content={
                "detail": {
                    "code": "upload_too_large",
                    "message": "G-code upload exceeds size limit.",
                }
            },
        )
        await response(scope, receive, send)
