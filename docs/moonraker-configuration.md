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
- `websocket_url_override`: optional WS(S) endpoint for later live-state support.

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

## Network policy

- Private and LAN addresses are allowed.
- Loopback, link-local, cloud metadata, multicast, and unspecified addresses
  are blocked, including blocked addresses returned by DNS.
- The HTTP connection is pinned to an approved DNS result and verifies the
  connected peer.
- Redirects and environment proxies are disabled.
- Timeouts and response size are bounded.
- LayerCove exposes no generic Moonraker proxy or arbitrary G-code endpoint.

End-user wiki and UI onboarding documentation belong to the later identity/docs
wave when Moonraker controls are exposed in the frontend.
