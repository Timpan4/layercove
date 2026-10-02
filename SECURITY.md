# Security policy

## Reporting a vulnerability

Do not report vulnerabilities in public issues, pull requests, or discussions.

Report them privately through GitHub: open the repository's [Security tab](https://github.com/Timpan4/layercove/security) and choose **Report a vulnerability**. Include:

- a description of the vulnerability and its impact;
- steps to reproduce;
- the affected LayerCove version or commit;
- a suggested fix, if you have one.

Reports are handled on a best-effort basis with no guaranteed response time. Reporters are credited in the fix's release notes unless they ask not to be.

## Supported versions

Only the latest published image (`ghcr.io/timpan4/layercove:latest`) and the `main` branch receive security fixes. Update before reporting an issue you found on an older build.

## Scope

In scope:

- authentication or authorization bypass;
- remote code execution;
- SQL injection;
- cross-site scripting (XSS) and cross-site request forgery (CSRF);
- sensitive data exposure;
- insecure direct object references.

Out of scope:

- vulnerabilities in dependencies (report them to that project);
- social engineering;
- denial of service;
- attacks that need physical access to the server or printers.

## Deployment guidance

### Network

LayerCove talks to Bambu printers on the local network over MQTT over TLS (port 8883) and FTPS (port 990).

Moonraker support assumes an administrator-configured, trusted printer origin. LayerCove makes backend HTTP and WebSocket connections to that origin, so adding a Moonraker printer grants LayerCove access to that printer's control API. Only administrators should create or edit printer connections.

Moonraker connections enforce these boundaries:

- Only credential-free `http://` or `https://` origins are accepted. API keys and authorization values are stored separately and encrypted at rest.
- DNS is resolved for each connection and the socket is pinned to an approved result. Loopback, link-local, multicast, unspecified, and known cloud metadata addresses are rejected. Private LAN and VPN addresses are allowed because they are the supported deployment topology.
- HTTP and WebSocket redirects are rejected. Configure the final Moonraker origin directly.
- Proxy environment variables are ignored for printer traffic. Connections have bounded timeouts and response sizes. Uploads accept only safe `.gcode` names and are size-bounded.
- TLS certificate verification is on by default for each printer. For a private certificate authority, install its CA certificate in the LayerCove host or container trust store. Disabling verification is a per-printer fallback for a trusted network only.
- Moonraker credentials are omitted from printer API responses and scrubbed from logs and support bundles. Redact exported diagnostics before publishing them anyway.
- Upload/start, pause, resume, cancel, and emergency stop require printer permissions. Emergency stop also requires an explicit confirmation payload. LayerCove exposes no generic G-code console, shell, or URL proxy.

See [docs/moonraker-configuration.md](docs/moonraker-configuration.md) for the full connection policy.

### Remote access and reverse proxies

Keep LayerCove and Moonraker on a trusted LAN or a private overlay such as Tailscale. For remote browser access, put LayerCove behind an authenticated HTTPS boundary such as a reverse proxy with authentication or Cloudflare Access. Never publish Moonraker directly. A tunnel alone is not application authorization.

Enable LayerCove authentication before any untrusted client can reach it. Grant printer-control and printer-file permissions only to users allowed to move, heat, start, or stop hardware. Keep Moonraker API keys and long-lived LayerCove tokens out of URLs, browser-visible configuration, proxy logs, and support tickets.

LayerCove ignores forwarded client-address headers unless `TRUSTED_PROXY_IPS` lists the direct proxy peers. Set it to the proxy addresses that actually connect to LayerCove, not to client networks or a broad subnet. LayerCove then reads `X-Forwarded-For` from right to left and uses the first address that is not a trusted proxy. Configure the proxy to set forwarded headers consistently, and make sure clients cannot bypass the proxy.

A public reverse proxy does not make printer protocols safe on the internet. Keep LayerCove-to-printer traffic on the trusted LAN or VPN, restrict routes and firewall rules to the required destinations, and protect backups, which contain encrypted credentials and application data. Connections validate and pin resolved peers to defend against DNS rebinding, but administrators still control the DNS zone and network path.

### Checklist

1. Keep LayerCove and printer protocols on a trusted LAN or private VPN.
2. Enable authentication and put remote access behind an authenticated HTTPS proxy or access gateway.
3. Never expose Moonraker directly.
4. Run the latest image.
5. Treat LayerCove and Moonraker API keys like passwords. Keep them out of URLs and public diagnostics.
6. Prefer a trusted private CA. Disable per-printer TLS verification only on a controlled network.
7. Do not share your Bambu printer's Developer Mode access code.

## Security rules for contributors

These rules apply to every pull request that touches authentication, authorization, permission checks, secret handling, or any code that decides whether to allow an action. CI enforces each rule except rule 4.

### 1. Default-deny allowlists

At a security boundary, deny by default and list exceptions explicitly. A denylist grants access to every new resource until someone remembers to deny it. An allowlist returns 403 for an unmapped resource, which is loud and recoverable.

- `_APIKEY_SCOPE_BY_PERMISSION` in `backend/app/core/auth.py` is the API-key authorization map. Every `Permission` value must appear there with a scope flag or in `_APIKEY_DENIED_PERMISSIONS`. Unmapped permissions return 403.
- Every route declares its auth dependency. A route without one must be in the route-audit `_PUBLIC_ROUTES` allowlist with a justification comment.

### 2. Fail closed in auth code

An `except Exception:` or bare `except:` in authentication, authorization, or permission code must re-raise or deny. It must never return a permissive value such as `None`, `True`, an admin user, or an empty filter ([CWE-636](https://cwe.mitre.org/data/definitions/636.html)).

The check covers `backend/app/core/auth.py`, `backend/app/core/permissions.py`, and `backend/app/api/routes/auth*.py`. Every `except Exception:` in those files needs a `# SEC-AUTH-EXC: <reason>` marker on the same line. The project uses its own marker because Ruff reserves `# noqa:` for its rule codes.

### 3. No hardcoded fallback secrets

JWT signing keys, encryption keys, OAuth client secrets, and API tokens have no string-literal fallback in source. They come from environment variables, a file in the data directory, or are generated on first run. CI fails on any `-change-in-production`-style string and on a hardcoded JWT secret fallback.

If a generated secret cannot be saved to the data directory, LayerCove keeps running: the JWT secret is regenerated on every restart, which invalidates sessions, and TOTP keys and OIDC client secrets are stored in plaintext. Set `JWT_SECRET_KEY` and `LAYERCOVE_SECRET_ENCRYPTION_KEY` (legacy alias `MFA_ENCRYPTION_KEY`), or fix the data directory's permissions, to avoid both.

### 4. Negative-path tests for auth changes

A pull request that adds or changes an auth dependency, permission check, or scope flag includes tests for:

- no credentials → 401;
- wrong credentials → 401;
- valid credentials with the wrong scope → 403;
- expired or revoked credentials → 401.

A happy-path test alone is not enough. Reviewers enforce this rule.

### 5. Safe joins under a trusted directory

Any path built from outside input, such as a request body, query or path parameter, `UploadFile.filename`, ZIP or tar member, or printer FTP listing entry, must be joined with `backend.app.utils.safe_path.safe_join_under(parent, *parts)`. The helper resolves the result and confirms it stays under the parent, which blocks absolute-path collapse and `..` traversal.

A site with its own guard, such as an explicit resolve plus `is_relative_to` or a basename-only helper, carries a `# SEC-PATH-OK: <reason>` marker on the same line. CI scans `backend/app/api/routes/` and `backend/app/services/` for unguarded joins. Services are included because a compromised printer can serve crafted FTP listing entries that reach a path join.

### Enforcement

| Rule | Test | Location |
|---|---|---|
| 1. Allowlist (permissions) | `test_every_permission_has_a_classification` | `backend/tests/integration/test_auth_apikey_rbac.py` |
| 1. Allowlist (routes) | `test_routes_have_explicit_auth_deps` | `backend/tests/unit/test_route_auth_coverage.py` |
| 2. Fail closed | `test_no_fail_open_in_auth_modules` | `backend/tests/unit/test_no_fail_open_in_auth.py` |
| 3. No fallback secrets | `test_no_hardcoded_secrets_in_production_source`, `test_jwt_secret_loader_has_no_hardcoded_fallback` | `backend/tests/unit/test_no_hardcoded_secrets.py` |
| 4. Negative-path tests | Pull request review | — |
| 5. Safe joins | `test_route_path_arithmetic_is_safe_joined_or_marked` | `backend/tests/unit/test_no_unsafe_path_joins.py` |

Update this table when you add a CI rule. A pull request that removes one must explain why.
