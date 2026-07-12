# Moonraker configuration

LayerCove stores one Moonraker origin per Moonraker printer. Creating a printer
requires `printers:create` and probes `GET /server/info` before saving. A failed
probe leaves no printer or credential row behind.

## Configuration

`moonraker_config` accepts:

- `base_url`: HTTP(S) origin only, with no credentials, path, query, or fragment.
- `api_key`: sent as `X-Api-Key`.
- `authorization`: sent as `Authorization`.
- `tls_verify`: per-printer certificate verification; defaults to `true`.
- `websocket_url_override`: optional WS(S) endpoint on the same host and effective
  port as `base_url`. HTTPS origins require WSS; HTTP origins may use WS.

`api_key` and `authorization` are mutually exclusive. Credentials are encrypted
at rest and responses expose only `api_key_configured` or
`authorization_configured`.

HTTPS verifies the printer certificate and hostname by default. For a
self-signed certificate, trust its CA in the LayerCove host/container when
possible. Set `tls_verify: false` only for that printer when the network and
certificate are trusted; this does not change global TLS behavior.

## Connection test

Call:

```text
POST /api/v1/printers/{printer_id}/test-connection
```

The endpoint requires `printers:update`, uses only stored configuration, and
returns a safe success or failure message. It accepts no URL, credential, or
request target. Updating a Moonraker config saves the update without probing;
call this endpoint afterward to validate the stored values.

## Live status

LayerCove opens one backend-owned WebSocket per active Moonraker printer. It
queries initial printer objects, subscribes to live changes, and forwards only
normalized status through LayerCove's existing frontend event stream. Browsers
never connect to Moonraker and raw provider payloads remain server-internal.

Disconnects retry at 1, 2, 4, 8, 16, then 30 seconds with bounded positive
jitter. A connection stable for 30 seconds resets that sequence. Shutdown
cancels and closes the owned task and socket. Initial query and subscription
responses, DNS, and handshake are bounded. WebSocket heartbeat pings detect a
silent peer and reconnect, while a healthy quiet printer stays connected. A
stalled Moonraker does not block reconnect forever.

## Upload and controls

`POST /api/v1/printers/{printer_id}/moonraker/upload-gcode` accepts one
multipart `file` and optional `start` form field. It requires `printers:files`,
accepts only a single `.gcode` basename, streams at most 4 GiB to Moonraker's
`gcodes` root, and returns Moonraker's `item.path`. `start=true` starts that
returned path. Uploads and print commands are never retried automatically.
The API rejects an oversized request with HTTP 413 while reading ingress,
including chunked requests without `Content-Length`, before multipart parsing
can spool the complete body. A second 4 GiB limit remains on the outbound file
stream. Upload transfer time has a separate four-hour wall-clock ceiling;
normal commands retain the 10-second request deadline.

Pause, resume, and cancel use Moonraker's dedicated print endpoints only when
the normalized state permits them. Emergency stop is separate:

```text
POST /api/v1/printers/{printer_id}/emergency-stop
{"confirmed": true}
```

It requires `printers:control`, calls only Moonraker's immediate
`/printer/emergency_stop` endpoint, and never sends `M112` through a generic
G-code path. Validate this only with a supervised hardware procedure.

## Network policy

- Private and LAN addresses are allowed.
- Loopback, link-local, cloud metadata, multicast, and unspecified addresses
  are blocked, including blocked addresses returned by DNS.
- The HTTP connection is pinned to an approved DNS result and verifies the
  connected peer.
- Redirects and environment proxies are disabled.
- Each request has one 10-second wall-clock deadline covering DNS resolution,
  all peer connection attempts, response headers, and the response body.
- Response bodies are limited to 64 KiB.
- LayerCove exposes no generic Moonraker proxy or arbitrary G-code endpoint.

External wiki and UI onboarding documentation remain deferred to issue #17.
