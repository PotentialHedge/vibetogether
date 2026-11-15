//! The backend as a service: it listens on 127.0.0.1 at `BACKEND_PORT`, 3000 by default, behind
//! a proxy that serves it at `BACKEND_URL`, and ends gracefully on SIGTERM or Ctrl-C.

use std::process::ExitCode;

use tokio::{net::TcpListener, signal};
use vibetogether_backend::{App, Config};

#[tokio::main]
async fn main() -> ExitCode {
  tracing_subscriber::fmt().with_target(false).init();
  let config = match Config::from_env() {
    Ok(config) => config,
    Err(e) => {
      eprintln!("vibetogether-backend: {e}");
      return ExitCode::from(2);
    }
  };
  let port: u16 = std::env::var("BACKEND_PORT")
    .ok()
    .and_then(|p| p.parse().ok())
    .unwrap_or(3000);
  let url = config.url.clone();
  let app = match App::new(config).await {
    Ok(app) => app,
    Err(e) => {
      eprintln!("vibetogether-backend: {e}");
      return ExitCode::FAILURE;
    }
  };
  let listener = match TcpListener::bind(("127.0.0.1", port)).await {
    Ok(listener) => listener,
    Err(e) => {
      eprintln!("vibetogether-backend: 127.0.0.1:{port}: {e}");
      return ExitCode::FAILURE;
    }
  };
  tracing::info!("listening on 127.0.0.1:{port}, for {url}");
  let shutdown = async {
    let terminate = async {
      if let Ok(mut term) = signal::unix::signal(signal::unix::SignalKind::terminate()) {
        term.recv().await;
      }
    };
    tokio::select! { _ = signal::ctrl_c() => {}, () = terminate => {} }
  };
  match axum::serve(listener, app.router())
    .with_graceful_shutdown(shutdown)
    .await
  {
    Ok(()) => ExitCode::SUCCESS,
    Err(e) => {
      eprintln!("vibetogether-backend: {e}");
      ExitCode::FAILURE
    }
  }
}
