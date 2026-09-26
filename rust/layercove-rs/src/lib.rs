//! Rust side of the Python/Rust coexistence in
//! `docs/decisions/0002-python-rust-coexistence.md`.
//!
//! The public listener serves `/health` and, later, API families moved from
//! Python. The internal listener is bound to loopback and carries the single
//! authenticated control session from the Python app.

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::State;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade, close_code};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};

/// Control-session protocol version exchanged in `hello` / `hello_ack`.
pub const PROTOCOL: u32 = 1;

pub const SESSION_PATH: &str = "/internal/v1/moonraker/session";

const DEFAULT_PORT: u16 = 8081;
const DEFAULT_INTERNAL_PORT: u16 = 8082;

#[derive(Debug)]
pub struct Config {
    pub token: String,
    pub port: u16,
    pub internal_port: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    MissingToken,
    InvalidPort(&'static str),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingToken => f.write_str("LAYERCOVE_INTERNAL_TOKEN must be set and non-empty"),
            Self::InvalidPort(name) => write!(f, "{name} must be a port number"),
        }
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Reads configuration through `var`, normally `std::env::var(..).ok()`.
    /// The service never starts without an internal token.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let token = var("LAYERCOVE_INTERNAL_TOKEN")
            .filter(|token| !token.is_empty())
            .ok_or(ConfigError::MissingToken)?;
        let port = |name: &'static str, default: u16| match var(name) {
            None => Ok(default),
            Some(value) => value.parse().map_err(|_| ConfigError::InvalidPort(name)),
        };
        Ok(Self {
            token,
            port: port("LAYERCOVE_RS_PORT", DEFAULT_PORT)?,
            internal_port: port("LAYERCOVE_RS_INTERNAL_PORT", DEFAULT_INTERNAL_PORT)?,
        })
    }
}

/// Serves both listeners until `shutdown` completes, then closes any open
/// control session and returns once the servers and the session have stopped.
pub async fn serve(
    public: TcpListener,
    internal: TcpListener,
    token: String,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let (stop_tx, stop_rx) = watch::channel(false);
    // Every session holds a sender clone; `recv` returns `None` once all ended.
    let (session_done, mut sessions_ended) = mpsc::channel::<()>(1);
    let state = InternalState {
        token: token.into(),
        session_active: Arc::default(),
        stop: stop_rx.clone(),
        _done: session_done,
    };

    let public_app = Router::new().route("/health", get(health));
    let internal_app = Router::new()
        .route(SESSION_PATH, get(session))
        .with_state(state);

    let (public_result, internal_result, ()) = tokio::join!(
        axum::serve(public, public_app).with_graceful_shutdown(stopped(stop_rx.clone())),
        axum::serve(internal, internal_app).with_graceful_shutdown(stopped(stop_rx)),
        async move {
            shutdown.await;
            // Receivers treat a dropped sender as a stop as well.
            let _ = stop_tx.send(true);
        },
    );
    sessions_ended.recv().await;
    public_result.and(internal_result)
}

async fn stopped(mut stop: watch::Receiver<bool>) {
    let _ = stop.wait_for(|stopped| *stopped).await;
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({"status": "ok"}))
}

#[derive(Clone)]
struct InternalState {
    token: Arc<str>,
    session_active: Arc<AtomicBool>,
    stop: watch::Receiver<bool>,
    _done: mpsc::Sender<()>,
}

async fn session(
    State(state): State<InternalState>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    // Authenticate before revealing anything else, including session state.
    if !authorized(&headers, &state.token) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(slot) = SessionSlot::claim(&state.session_active) else {
        return error_response(StatusCode::CONFLICT, "session_active");
    };
    // If the upgrade fails, axum drops this closure and with it the slot.
    upgrade.on_upgrade(move |socket| run_session(socket, state, slot))
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.as_bytes().strip_prefix(b"Bearer "))
        .is_some_and(|given| constant_time_eq(given, token.as_bytes()))
}

/// Compares without an early exit so response timing does not reveal how
/// much of the token matched. The length is not treated as secret.
fn constant_time_eq(given: &[u8], expected: &[u8]) -> bool {
    given.len() == expected.len()
        && given
            .iter()
            .zip(expected)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn error_response(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({"code": code}))).into_response()
}

/// Holds the only control session; releasing it on drop covers normal end,
/// errors, cancellation, and failed upgrades.
struct SessionSlot(Arc<AtomicBool>);

impl SessionSlot {
    fn claim(active: &Arc<AtomicBool>) -> Option<Self> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(Arc::clone(active)))
    }
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Hello { protocol: u32 },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    HelloAck {
        protocol: u32,
        version: &'static str,
    },
    Error {
        code: &'static str,
    },
}

enum Ending {
    PeerClosed,
    Violation(&'static str),
    Stopping,
}

async fn run_session(mut socket: WebSocket, mut state: InternalState, _slot: SessionSlot) {
    let ending = tokio::select! {
        ending = converse(&mut socket) => ending,
        _ = state.stop.wait_for(|stopped| *stopped) => Ending::Stopping,
    };
    let close = match ending {
        Ending::PeerClosed => return,
        Ending::Violation(code) => {
            if send(&mut socket, &ServerMessage::Error { code })
                .await
                .is_err()
            {
                return;
            }
            CloseFrame {
                code: close_code::PROTOCOL,
                reason: Utf8Bytes::from_static(code),
            }
        }
        Ending::Stopping => CloseFrame {
            code: close_code::AWAY,
            reason: Utf8Bytes::from_static("shutting_down"),
        },
    };
    let _ = socket.send(Message::Close(Some(close))).await;
}

async fn converse(socket: &mut WebSocket) -> Ending {
    let first = match next_text(socket).await {
        Ok(text) => text,
        Err(ending) => return ending,
    };
    match serde_json::from_str(&first) {
        Ok(ClientMessage::Hello { protocol: PROTOCOL }) => {}
        Ok(ClientMessage::Hello { .. }) => return Ending::Violation("protocol_mismatch"),
        Err(_) => return Ending::Violation("malformed_message"),
    }
    let ack = ServerMessage::HelloAck {
        protocol: PROTOCOL,
        version: env!("CARGO_PKG_VERSION"),
    };
    if send(socket, &ack).await.is_err() {
        return Ending::PeerClosed;
    }
    // Protocol 1 defines no messages after the handshake yet.
    match next_text(socket).await {
        Ok(_) => Ending::Violation("unsupported_message"),
        Err(ending) => ending,
    }
}

async fn next_text(socket: &mut WebSocket) -> Result<Utf8Bytes, Ending> {
    loop {
        match socket.recv().await {
            Some(Ok(Message::Text(text))) => return Ok(text),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(Message::Binary(_))) => return Err(Ending::Violation("malformed_message")),
            Some(Ok(Message::Close(_)) | Err(_)) | None => return Err(Ending::PeerClosed),
        }
    }
}

async fn send(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), axum::Error> {
    let text = serde_json::to_string(message).expect("server messages always serialize");
    socket.send(Message::Text(text.into())).await
}
