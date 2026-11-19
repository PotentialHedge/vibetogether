//! The website, served beside the API where the backend is given its build (`Config::site`), so
//! that one process is a whole server, such as one run privately: the same pages and headers the
//! public host's Caddy serves them with, but Umami's address, which only the public site sends to.

use std::path::Path;

use axum::{
  Router,
  http::{HeaderName, HeaderValue, header},
};
use tower_http::{
  services::{ServeDir, ServeFile},
  set_header::SetResponseHeaderLayer,
};

use crate::App;

/// The page's own scripts and WebAssembly only; it shows GitHub's avatars and payloads as blob:
/// images, and calls this server's API and the owner's other servers', over HTTPS, or over plain HTTP on loopback, as a server's address may be there. No other
/// site frames it, since it approves OTPs with one click.
const POLICY: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: https://avatars.githubusercontent.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

pub fn router(dir: &Path) -> Router<App> {
  let header = |name: HeaderName, value: &'static str| {
    SetResponseHeaderLayer::overriding(name, HeaderValue::from_static(value))
  };
  // An invite's link, /i/<code>, is one page, which reads the code from the path.
  let invite = ServeFile::new(dir.join("i/index.html"));
  Router::new()
    .nest_service("/i", invite)
    .fallback_service(ServeDir::new(dir))
    .layer(header(header::CONTENT_SECURITY_POLICY, POLICY))
    .layer(header(header::X_FRAME_OPTIONS, "DENY"))
    .layer(header(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
    .layer(header(
      header::REFERRER_POLICY,
      "strict-origin-when-cross-origin",
    ))
    .layer(header(
      header::CACHE_CONTROL,
      "public, max-age=0, must-revalidate",
    ))
}
