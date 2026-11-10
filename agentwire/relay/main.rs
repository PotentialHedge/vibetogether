//! The agentwire relay as a program: it listens at `AGENTWIRE_ADDRESS`, by default
//! 127.0.0.1:8790, and keeps its sessions in the database at
//! `AGENTWIRE_DATABASE`, or in memory without one. It serves the spec and the
//! script from the directory `AGENTWIRE_FILES`, by default the working directory,
//! as the repository's root is for `just dev`. With `AGENTWIRE_ACCESS`, it asks
//! the access service at that URL who may be in a session, and which sessions last.
//! With `AGENTWIRE_MIN_FREE`, in bytes, it refuses whatever adds to the database
//! once its filesystem has less free.

use std::env;
use std::error::Error;
use std::net::SocketAddr;
use std::path::PathBuf;

use agentwire_relay::{Options, Relay};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let address = env::var("AGENTWIRE_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8790".to_owned());
    let database = env::var_os("AGENTWIRE_DATABASE").map(PathBuf::from);
    let files = env::var_os("AGENTWIRE_FILES").map_or_else(|| PathBuf::from("."), PathBuf::from);
    let access = env::var("AGENTWIRE_ACCESS")
        .ok()
        .filter(|url| !url.is_empty());
    let min_free = match env::var("AGENTWIRE_MIN_FREE") {
        Ok(bytes) => Some(bytes.parse()?),
        Err(_) => None,
    };
    let relay = Relay::open(Options {
        database,
        files: Some(files),
        access,
        min_free,
    })?;
    tokio::spawn(relay.clone().expire());
    let listener = TcpListener::bind(&address).await?;
    let router = relay.router();
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
