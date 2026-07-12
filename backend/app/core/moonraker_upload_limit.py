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
        limit_exceeded = False
        response_messages = []

        async def limited_receive():
            nonlocal limit_exceeded, received
            if limit_exceeded:
                raise _UploadBodyTooLarge
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body_bytes:
                    limit_exceeded = True
                    raise _UploadBodyTooLarge
            return message

        async def buffered_send(message):
            response_messages.append(message)

        try:
            await self.app(scope, limited_receive, buffered_send)
        except _UploadBodyTooLarge:
            limit_exceeded = True

        if limit_exceeded:
            await self._reject(scope, receive, send)
            return

        for message in response_messages:
            await send(message)

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
