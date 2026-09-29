# layercove-rs

The Rust service that runs next to the Python app while capabilities move over
one at a time. Design: [ADR 0002](../docs/decisions/0002-python-rust-coexistence.md).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAYERCOVE_INTERNAL_TOKEN` | required | Bearer token for the internal listener. The service refuses to start without it. |
| `LAYERCOVE_RS_PORT` | `8081` | Public listener on `0.0.0.0`: `GET /health` and API families moved to Rust. |
| `LAYERCOVE_RS_INTERNAL_PORT` | `8082` | Internal listener, always `127.0.0.1`: the Python control session at `/internal/v1/moonraker/session`. |

The process stops cleanly on SIGTERM or Ctrl-C, closing an open control session
with WebSocket close code 1001.

## Develop

```sh
cd rust
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
LAYERCOVE_INTERNAL_TOKEN=dev cargo run
```

The toolchain is pinned in `rust-toolchain.toml`.

## Image

```sh
docker build -t layercove-rs rust
```

CI publishes `ghcr.io/timpan4/layercove-rs` for `linux/amd64` and `linux/arm64`
after CI passes on `main`, tagged `main` and `sha-<commit>`.
