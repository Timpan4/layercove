use std::net::Ipv4Addr;
use std::process::ExitCode;

use layercove_rs::{Config, serve};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::from_vars(|name| std::env::var(name).ok()) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("layercove-rs: {err}");
            return ExitCode::FAILURE;
        }
    };
    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("layercove-rs: {err}");
            ExitCode::FAILURE
        }
    }
}

async fn run(config: Config) -> std::io::Result<()> {
    // Kubernetes stops containers with SIGTERM; PID 1 ignores it unless handled.
    #[cfg(unix)]
    let shutdown = {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate())?;
        async move {
            tokio::select! {
                _ = terminate.recv() => {}
                Ok(()) = tokio::signal::ctrl_c() => {}
            }
        }
    };
    #[cfg(not(unix))]
    let shutdown = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };

    let public = TcpListener::bind((Ipv4Addr::UNSPECIFIED, config.port)).await?;
    // ADR 0002: the internal listener is never bound beyond loopback.
    let internal = TcpListener::bind((Ipv4Addr::LOCALHOST, config.internal_port)).await?;
    eprintln!(
        "layercove-rs {} listening on 0.0.0.0:{} (internal 127.0.0.1:{})",
        env!("CARGO_PKG_VERSION"),
        config.port,
        config.internal_port
    );
    serve(public, internal, config.token, shutdown).await
}
