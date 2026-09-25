//! Drives the real listeners over TCP, as the Python app and kubelet will.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use layercove_rs::{Config, ConfigError, PROTOCOL, SESSION_PATH, serve};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "test-internal-token";
/// Bounds each test wait so a regression fails instead of hanging CI.
const WAIT: Duration = Duration::from_secs(5);

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Service {
    public: SocketAddr,
    internal: SocketAddr,
    stop: oneshot::Sender<()>,
    task: JoinHandle<std::io::Result<()>>,
}

async fn start() -> Service {
    let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let internal = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (public_addr, internal_addr) =
        (public.local_addr().unwrap(), internal.local_addr().unwrap());
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(serve(public, internal, TOKEN.to_owned(), async {
        let _ = stopped.await;
    }));
    Service {
        public: public_addr,
        internal: internal_addr,
        stop,
        task,
    }
}

async fn http_get(addr: SocketAddr, path: &str) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    timeout(WAIT, stream.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    response
}

async fn connect(
    addr: SocketAddr,
    authorization: Option<&str>,
) -> Result<Client, tungstenite::Error> {
    let mut request = format!("ws://{addr}{SESSION_PATH}")
        .into_client_request()
        .unwrap();
    if let Some(value) = authorization {
        request
            .headers_mut()
            .insert("authorization", value.parse().unwrap());
    }
    timeout(WAIT, tokio_tungstenite::connect_async(request))
        .await
        .unwrap()
        .map(|(client, _)| client)
}

fn rejected_status(result: Result<Client, tungstenite::Error>) -> u16 {
    match result {
        Err(tungstenite::Error::Http(response)) => response.status().as_u16(),
        Err(other) => panic!("expected an HTTP rejection, got {other}"),
        Ok(_) => panic!("expected an HTTP rejection, got a session"),
    }
}

async fn authorized(addr: SocketAddr) -> Client {
    connect(addr, Some(&format!("Bearer {TOKEN}")))
        .await
        .unwrap()
}

async fn next_message(client: &mut Client) -> Option<Message> {
    loop {
        match timeout(WAIT, client.next()).await.unwrap() {
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(message)) => return Some(message),
            Some(Err(_)) | None => return None,
        }
    }
}

async fn next_json(client: &mut Client) -> Value {
    match next_message(client).await {
        Some(Message::Text(text)) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected a text message, got {other:?}"),
    }
}

async fn expect_close(client: &mut Client, code: CloseCode) {
    match next_message(client).await {
        Some(Message::Close(Some(frame))) => assert_eq!(frame.code, code),
        other => panic!("expected close {code:?}, got {other:?}"),
    }
}

async fn send_json(client: &mut Client, value: Value) {
    client.send(Message::text(value.to_string())).await.unwrap();
}

async fn handshake(client: &mut Client) {
    send_json(client, json!({"type": "hello", "protocol": PROTOCOL})).await;
    let ack = next_json(client).await;
    assert_eq!(ack["type"], "hello_ack");
    assert_eq!(ack["protocol"], PROTOCOL);
    assert_eq!(ack["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn health_is_public_and_internal_routes_are_not() {
    let service = start().await;

    let health = http_get(service.public, "/health").await;
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    assert!(health.ends_with(r#"{"status":"ok"}"#), "{health}");

    let internal_on_public = http_get(service.public, SESSION_PATH).await;
    assert!(
        internal_on_public.starts_with("HTTP/1.1 404"),
        "{internal_on_public}"
    );
}

#[tokio::test]
async fn session_requires_the_exact_internal_token() {
    let service = start().await;

    for authorization in [
        None,
        Some("Bearer wrong-token"),
        Some(TOKEN),
        Some("bearer test-internal-token"),
        Some("Bearer test-internal-token-longer"),
        Some("Bearer "),
    ] {
        let status = rejected_status(connect(service.internal, authorization).await);
        assert_eq!(status, 401, "authorization {authorization:?}");
    }
}

#[tokio::test]
async fn hello_is_acknowledged_and_later_messages_are_rejected() {
    let service = start().await;
    let mut client = authorized(service.internal).await;

    handshake(&mut client).await;

    send_json(&mut client, json!({"type": "connect"})).await;
    assert_eq!(
        next_json(&mut client).await,
        json!({"type": "error", "code": "unsupported_message"})
    );
    expect_close(&mut client, CloseCode::Protocol).await;
}

#[tokio::test]
async fn invalid_first_messages_close_the_session() {
    let service = start().await;
    let cases = [
        (
            Message::text(json!({"type": "hello", "protocol": PROTOCOL + 1}).to_string()),
            "protocol_mismatch",
        ),
        (Message::text("{not json"), "malformed_message"),
        (
            Message::text(json!({"type": "connect"}).to_string()),
            "malformed_message",
        ),
        (Message::binary(vec![1, 2, 3]), "malformed_message"),
    ];

    for (message, code) in cases {
        let mut client = authorized(service.internal).await;
        client.send(message).await.unwrap();
        assert_eq!(
            next_json(&mut client).await,
            json!({"type": "error", "code": code})
        );
        expect_close(&mut client, CloseCode::Protocol).await;
        // The slot frees once the session ends, so the next case can connect.
        while next_message(&mut client).await.is_some() {}
    }
}

#[tokio::test]
async fn only_one_session_is_accepted_at_a_time() {
    let service = start().await;
    let mut first = authorized(service.internal).await;
    handshake(&mut first).await;

    let status = rejected_status(connect(service.internal, Some(&format!("Bearer {TOKEN}"))).await);
    assert_eq!(status, 409);

    first.close(None).await.unwrap();
    while next_message(&mut first).await.is_some() {}

    // Closing is asynchronous on the server; retry until the slot is released.
    let mut second = timeout(WAIT, async {
        loop {
            match connect(service.internal, Some(&format!("Bearer {TOKEN}"))).await {
                Ok(client) => return client,
                Err(tungstenite::Error::Http(response)) if response.status() == 409 => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(other) => panic!("unexpected error: {other}"),
            }
        }
    })
    .await
    .unwrap();
    handshake(&mut second).await;
}

#[tokio::test]
async fn shutdown_closes_the_open_session_and_stops_both_listeners() {
    let service = start().await;
    let mut client = authorized(service.internal).await;
    handshake(&mut client).await;

    service.stop.send(()).unwrap();

    expect_close(&mut client, CloseCode::Away).await;
    drop(client);
    timeout(WAIT, service.task).await.unwrap().unwrap().unwrap();
    assert!(TcpStream::connect(service.public).await.is_err());
    assert!(TcpStream::connect(service.internal).await.is_err());
}

fn config(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Config::from_vars(|name| vars.get(name).cloned())
}

#[test]
fn config_refuses_to_start_without_a_token() {
    assert_eq!(config(&[]).unwrap_err(), ConfigError::MissingToken);
    assert_eq!(
        config(&[("LAYERCOVE_INTERNAL_TOKEN", "")]).unwrap_err(),
        ConfigError::MissingToken
    );
}

#[test]
fn config_ports_default_and_reject_invalid_values() {
    let defaults = config(&[("LAYERCOVE_INTERNAL_TOKEN", TOKEN)]).unwrap();
    assert_eq!((defaults.port, defaults.internal_port), (8081, 8082));

    let custom = config(&[
        ("LAYERCOVE_INTERNAL_TOKEN", TOKEN),
        ("LAYERCOVE_RS_PORT", "9100"),
        ("LAYERCOVE_RS_INTERNAL_PORT", "9101"),
    ])
    .unwrap();
    assert_eq!((custom.port, custom.internal_port), (9100, 9101));

    assert_eq!(
        config(&[
            ("LAYERCOVE_INTERNAL_TOKEN", TOKEN),
            ("LAYERCOVE_RS_PORT", "70000")
        ])
        .unwrap_err(),
        ConfigError::InvalidPort("LAYERCOVE_RS_PORT")
    );
}
