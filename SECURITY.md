# Security Policy

## Reporting a Vulnerability

The Bambuddy team takes security seriously. We appreciate your efforts to responsibly disclose your findings.

### How to Report

**Please DO NOT report security vulnerabilities through public GitHub.**

Instead, please report them via email to:

**security@bambuddy.cool**

### What to Include

Please include the following information in your report:

- **Description** of the vulnerability
- **Steps to reproduce** the issue
- **Affected versions** of Bambuddy
- **Potential impact** of the vulnerability
- **Any suggested fixes** (if you have them)

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your report within 48 hours
- **Assessment**: We will investigate and validate the issue within 7 days
- **Updates**: We will keep you informed of our progress
- **Resolution**: We aim to release a fix within 30 days for critical issues
- **Credit**: We will credit you in our release notes (unless you prefer to remain anonymous)

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| 0.2.x   | :white_check_mark: |

## Security Considerations

### Network Security

Bambuddy communicates with Bambu printers over your local network using:

- **MQTT over TLS** (port 8883) - Encrypted printer communication
- **FTPS** (port 990) - Encrypted file transfers

LayerCove's Moonraker support is designed for an administrator-configured,
trusted printer origin. It makes backend HTTP and WebSocket connections to that
origin, so adding a Moonraker printer grants the application access to that
printer's control API. Only administrators should create or edit printer
connections.

Moonraker connections enforce the following boundaries:

- Only credential-free `http://` or `https://` origins are accepted. API keys
  and authorization values are stored separately and encrypted at rest.
- DNS is resolved for each connection and the socket is pinned to an approved
  result. Loopback, link-local, multicast, unspecified, and known cloud metadata
  addresses are rejected. Private LAN and VPN addresses are intentionally
  allowed because they are the supported deployment topology.
- HTTP and WebSocket redirects are rejected rather than followed. Configure the
  final Moonraker origin directly.
- Environment proxy variables are ignored for printer traffic. Connections have
  bounded timeouts and response/message sizes; uploads accept safe `.gcode`
  names and remain size-bounded.
- TLS certificate verification is enabled by default per printer. For a private
  certificate authority, install its CA certificate in the LayerCove host or
  container trust store. Disabling verification is an explicit per-printer
  fallback for a trusted network, not a global setting and not suitable across
  an untrusted network.
- Moonraker credentials are omitted from printer API responses and scrubbed
  from log and support-bundle output. Operators must still redact exported
  diagnostics before publishing them.
- Upload/start, pause, resume, cancel, and emergency stop require printer
  permissions. Emergency stop also requires an explicit confirmation payload.
  LayerCove does not expose a generic G-code console, shell, or arbitrary URL
  proxy.

### Remote access and reverse proxies

LayerCove and Moonraker should remain on a trusted LAN or private overlay such
as Tailscale. If remote browser access is required, place LayerCove behind an
authenticated HTTPS boundary such as a correctly configured reverse proxy or
Cloudflare Access/Tunnel. Do not publish Moonraker directly, and do not treat a
tunnel by itself as application authorization.

Authentication must be enabled in LayerCove before it is reachable by untrusted
clients. Grant printer-control and printer-file permissions only to users who
may move, heat, start, or stop physical hardware. Keep Moonraker API keys and
long-lived LayerCove tokens out of URLs, browser-visible configuration, proxy
logs, and support tickets.

Forwarded client-address headers are ignored unless `TRUSTED_PROXY_IPS` lists
the direct proxy peers. Set it to the proxy addresses that actually connect to
LayerCove, not to client networks and not to a broad subnet. The application
then evaluates `X-Forwarded-For` from right to left and uses the first address
that is not a trusted proxy. Configure the proxy to replace or append forwarded
headers consistently and prevent clients from reaching LayerCove around the
proxy.

A public reverse proxy does not make printer protocols internet-safe. Keep
LayerCove-to-printer traffic on the trusted LAN/VPN, restrict network routes and
firewall rules to required destinations, and protect backups because they
contain encrypted credentials and application data. DNS rebinding defenses
validate and pin resolved peers for each connection, but administrators remain
responsible for controlling the configured DNS zone and network path.

### Recommendations

1. **Run on a trusted network**: Keep LayerCove and printer protocols on a trusted LAN or private VPN
2. **Authenticate remote access**: Enable LayerCove authentication and use an authenticated HTTPS reverse proxy or access gateway
3. **Do not expose Moonraker directly**: Configure its private origin in LayerCove and restrict it with network policy
4. **Keep updated**: Always run the latest version for security patches
5. **Secure credentials**: Treat LayerCove and Moonraker API keys like passwords; do not put them in URLs or public diagnostics
6. **Verify TLS**: Prefer a trusted private CA; disable per-printer verification only on a controlled network
7. **Developer Mode**: Use your Bambu printer's Developer Mode access code; don't share it

### Known Security Features

- API key and role-based authentication for external access
- No default credentials
- Local and private-network deployment by default (no cloud dependency)
- TLS support for printer communication
- Per-request Moonraker DNS validation and connection pinning
- Redirect, proxy-environment, response-size, timeout, filename, and command boundaries
- Stored-secret redaction in API, log, and support-bundle paths

## Scope

The following are **in scope** for security reports:

- Authentication/authorization bypasses
- Remote code execution
- SQL injection
- Cross-site scripting (XSS)
- Cross-site request forgery (CSRF)
- Sensitive data exposure
- Insecure direct object references

The following are **out of scope**:

- Issues in dependencies (report to the upstream project)
- Social engineering attacks
- Physical attacks
- Denial of service (DoS) attacks
- Issues requiring physical access to the server

## Bambuddy Security Stance

The following rules apply to every PR that touches authentication,
authorization, permission gating, secret handling, or any code that
decides whether to allow or deny an action. They are not aspirational —
each one is enforced by a CI test that fails the build on violation.

### 1. Default-deny, allowlist over denylist

At any security boundary, the safe default is to deny and the
exceptions are listed explicitly. Denylists fail open on growth — every
new resource added to the codebase is implicitly granted access until
someone remembers to deny it. Allowlists fail closed: an unmapped new
resource gets a 403, which is loud and recoverable.

Concretely:

- `_APIKEY_SCOPE_BY_PERMISSION` in `backend/app/core/auth.py` is the
  load-bearing API-key authorization map. Every `Permission` enum value
  must be either present here with a scope flag, or present in
  `_APIKEY_DENIED_PERMISSIONS`. Unmapped permissions return 403.
- Route auth dependencies are explicit, not implicit. A route without a
  `Depends(require_*)` decorator must be listed in the route-audit
  `PUBLIC_ROUTES` allowlist with a justification comment, or CI fails.

### 2. Fail-closed in auth code

No `except Exception:` (or bare `except:`) in authentication,
authorization, or permission code may return a permissive value
(`None`, `True`, an admin user, an empty filter that lets everything
through, etc.). The catch-all either re-raises or returns a denial.
This is CWE-636 "Not Failing Securely" — see
<https://cwe.mitre.org/data/definitions/636.html>.

The lint scope is `backend/app/core/auth.py`,
`backend/app/core/permissions.py`,
`backend/app/api/routes/auth*.py`. Any `except Exception:` block in
those files must be tagged `# SEC-AUTH-EXC: <reason>` on the same
line; CI fails otherwise. (We use a standalone marker rather than
`# noqa: ...` because ruff reserves the latter syntax for its own
error codes.)

### 3. No hardcoded fallback secrets

Production secrets (JWT signing keys, encryption keys, OAuth client
secrets, API tokens) have no string-literal fallback in source. The
codebase reads them from env vars or generates them on first run; if a
secret is missing AND cannot be generated, the app refuses to start
rather than booting with a known value. CI greps the source for
`-change-in-production`-shaped strings and fails on any hit.

### 4. Negative-path tests required for any auth change

Any PR that adds or modifies an auth dependency, permission check, or
scope flag includes tests for the negative paths:

- "No credentials → 401"
- "Wrong credentials → 401"
- "Right credentials, wrong scope → 403"
- "Expired / revoked credentials → 401"

A test asserting the happy path passes is necessary but not sufficient.
The failure modes are where the vulnerabilities live. The structural
backstops above catch *categories* of regression; the negative-path
tests catch *specific* regressions in the new code.

### 5. Path joins under a trusted parent use the safe-join helper

Anywhere a Bambuddy code path joins a string from outside the function's
scope (request body, query/path param, `UploadFile.filename`, ZIP
`namelist()` entry, tarfile member, **printer FTP-listing entry**) under
a trusted directory, the join must route through
`backend.app.utils.safe_path.safe_join_under(parent, *parts)`. The helper
resolves the joined path and asserts it is a descendant of the parent —
defeating both absolute-path collapse (`Path("/a") / "/b"` → `Path("/b")`)
and `..` traversal.

Sites that have an inline guard (an explicit resolve + `is_relative_to`,
a basename-stripping helper like `_safe_filename`, or a pre-validated
alphanumeric filter) carry a `# SEC-PATH-OK: <reason>` marker on the
same line. CI walks **both** `backend/app/api/routes/` and
`backend/app/services/` and fails the build on any
``<dir-like> / <variable>`` join without either the helper or the
marker. The services layer is in scope because it receives values from
the routes verbatim and from external sources Bambuddy has no control
over (the compromised-printer threat model: a malicious printer can
serve crafted FTP-listing entries that flow straight into a path join).

### Where these rules live in the codebase

| Rule | Enforcement | Location |
|------|-------------|----------|
| 1. Allowlist over denylist (Permission) | `test_every_permission_has_a_classification` | `backend/tests/integration/test_auth_apikey_rbac.py` |
| 1. Allowlist over denylist (routes) | `test_routes_have_explicit_auth_deps` | `backend/tests/unit/test_route_auth_coverage.py` |
| 2. Fail-closed in auth code | `test_no_fail_open_in_auth_modules` | `backend/tests/unit/test_no_fail_open_in_auth.py` |
| 3. No hardcoded fallback secrets | `test_no_hardcoded_secrets` | `backend/tests/unit/test_no_hardcoded_secrets.py` |
| 4. Negative-path tests required | Reviewer responsibility (no automated CI gate yet) | PR review |
| 5. Safe-join under trusted parent | `test_route_path_arithmetic_is_safe_joined_or_marked` | `backend/tests/unit/test_no_unsafe_path_joins.py` |

If you are adding a CI rule, update this table. If you are removing a
CI rule, you are removing a security backstop and the PR description
must explain why.

---

Thank you for helping keep Bambuddy and its users safe!
