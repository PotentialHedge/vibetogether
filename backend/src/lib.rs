//! Vibe Together's backend: one process that serves the whole API under `/api/`, accounts and
//! sessions alike, as `vibetogether-protocol` defines it. Everything lasting is in one SQLite
//! database; what waits, such as a receive, is in memory beside it, so a restart ends it and its
//! client asks again.

mod account;
mod auth;
mod caller;
mod changes;
mod config;
mod db;
mod error;
mod extract;
mod friends;
mod groups;
mod invites;
mod legacy;
mod limits;
mod servers;
mod sessions;
mod site;
mod transport;
mod trash;

use std::{ops::Deref, sync::Arc, time::Instant};

use axum::{
  Router,
  extract::{Request, State},
  http::{HeaderValue, Method},
  middleware::{self, Next},
  response::IntoResponse,
  response::Response,
  routing::{get, post, put},
};
use sqlx::SqlitePool;
use vibetogether_protocol::{LoginKind, VERSION, VERSION_HEADER};

pub use crate::config::{Config, Identity};

/// The backend, shared by every request.
#[derive(Clone)]
pub struct App(Arc<Shared>);

pub struct Shared {
  pub config: Config,
  db: SqlitePool,
  github: reqwest::Client,
  changes: changes::Changes,
  live: transport::Live,
  otps: auth::Otps,
  limits: limits::Limits,
  /// The owner's account, by its id, on a server with an owner.
  owner: Option<String>,
}

impl Deref for App {
  type Target = Shared;
  fn deref(&self) -> &Shared {
    &self.0
  }
}

impl App {
  /// The backend on its database, which it makes, migrates, and fills from the TypeScript
  /// backend's where that is there.
  pub async fn new(config: Config) -> Result<Self, String> {
    let db = db::open(&config.database).await?;
    let owner = match config.owner() {
      Some(name) => Some(
        auth::owner_of(&db, name)
          .await
          .map_err(|e| format!("the owner's account: {}", e.message))?,
      ),
      None => None,
    };
    let app = Self(Arc::new(Shared {
      owner,
      config,
      db,
      github: reqwest::Client::new(),
      changes: changes::Changes::default(),
      live: transport::Live::default(),
      otps: auth::Otps::default(),
      limits: limits::Limits::default(),
    }));
    transport::start(&app);
    Ok(app)
  }

  /// Signs a person up, or updates them, as GitHub has them: their account's id.
  pub async fn sign_up(
    &self,
    github: i64,
    login: &str,
    display_name: &str,
    image: Option<&str>,
  ) -> error::Result<String> {
    auth::sign_up(self, github, login, display_name, image).await
  }

  /// A new login of the account, of `kind`: its secret, which a browser's cookie or a token holds.
  pub async fn new_login(
    &self,
    account: &str,
    kind: LoginKind,
    name: &str,
  ) -> error::Result<String> {
    auth::new_login(self, account, kind, name).await
  }

  /// The API, with every request logged by its method, path, status and time: nothing of its
  /// query, headers or body, which hold tokens and links, and its path without the codes of
  /// OTPs and invites. Every answer names the API's version.
  pub fn router(&self) -> Router {
    let api = Router::new()
      .route("/me", get(account::me).delete(account::delete))
      .route("/overview", get(account::overview))
      .route("/activity", get(account::activity))
      .route("/groups", get(groups::list).post(groups::create))
      .route(
        "/groups/{id}",
        axum::routing::patch(groups::rename).delete(groups::delete),
      )
      .route(
        "/groups/{id}/members/{name}",
        put(groups::add_member).delete(groups::remove_member),
      )
      .route(
        "/projects",
        get(groups::projects).post(groups::create_project),
      )
      .route(
        "/projects/{id}",
        axum::routing::patch(groups::change_project).delete(groups::delete_project),
      )
      .route("/agents", get(account::agents).post(account::create_agent))
      .route(
        "/agents/{id}",
        axum::routing::patch(account::rename_agent).delete(account::delete_agent),
      )
      .route("/trash", get(trash::list))
      .route("/trash/{id}/restore", post(trash::restore))
      .route("/status", put(account::set_status))
      .route("/sessions", get(sessions::list).post(sessions::create))
      .route(
        "/sessions/{id}",
        get(sessions::show)
          .patch(sessions::rename)
          .delete(sessions::delete),
      )
      .route(
        "/sessions/{id}/participants",
        get(sessions::participants)
          .post(sessions::join)
          .delete(sessions::leave),
      )
      .route("/sessions/{id}/notify", put(sessions::notify))
      .route("/sessions/{id}/entries", post(sessions::send))
      .route("/sessions/{id}/entries/{n}", get(sessions::fetch))
      .route("/sessions/{id}/log", get(sessions::log))
      .route("/receive", get(sessions::receive))
      .route("/friends", get(friends::list))
      .route("/friends/{name}", put(friends::add).delete(friends::remove))
      .route("/dms", get(friends::dms))
      .route("/logins", get(auth::logins))
      .route("/logins/{id}", axum::routing::delete(auth::revoke))
      .route("/invites", get(invites::list).post(invites::create))
      .route(
        "/invites/{code}",
        get(invites::show).delete(invites::revoke),
      )
      .route("/invites/{code}/accept", post(invites::accept))
      .route("/auth/sign-in", get(auth::sign_in))
      // Its first name, which websites built before servers with an owner still call.
      .route("/auth/github", get(auth::sign_in))
      .route("/auth/callback/github", get(auth::signed_in))
      .route("/auth/sign-out", post(auth::sign_out))
      .route("/otp/{code}", get(auth::show_otp))
      .route("/otp/{code}/approve", post(auth::approve_otp))
      .route("/otp/{code}/deny", post(auth::deny_otp))
      .layer(middleware::from_fn_with_state(self.clone(), written))
      // Asking for an OTP and redeeming it is anyone's, and changes nothing anyone waits on.
      .route("/otp", post(auth::request_otp))
      .route("/server", get(servers::info))
      .route("/otp/redeem", post(auth::redeem_otp))
      // A receive changes nothing anyone waits on, so it stays outside `written` like a GET.
      .route("/receive/agents", post(sessions::receive_agents));
    let api = Router::new()
      .nest("/api", api)
      .layer(middleware::from_fn(logged))
      .layer(middleware::map_response(versioned))
      .layer(cors());
    let router = match &self.config.site {
      Some(dir) => api.merge(site::router(dir)),
      None => api,
    };
    let router = if self.owner.is_some() {
      router.layer(middleware::from_fn_with_state(self.clone(), own_host))
    } else {
      router
    };
    router.with_state(self.clone())
  }
}

/// Any web client on any origin, such as a page served on a person's own machine, calls the API
/// with a token, Luis's decision (2026-11-16): CORS for every origin, without credentials, so a
/// browser sends no cookie with such a call and gives no page an answer made by one. The cookie
/// stays the website's own, as `caller` checks.
fn cors() -> tower_http::cors::CorsLayer {
  use axum::http::header;
  tower_http::cors::CorsLayer::new()
    .allow_origin(tower_http::cors::Any)
    .allow_methods([
      Method::GET,
      Method::POST,
      Method::PUT,
      Method::PATCH,
      Method::DELETE,
    ])
    .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
    .expose_headers([
      header::HeaderName::from_static(VERSION_HEADER),
      header::RETRY_AFTER,
      header::CONTENT_DISPOSITION,
    ])
    .max_age(std::time::Duration::from_secs(86400))
}

/// Every write that went through wakes what waits for a change (`changes`): a write by a login,
/// since every route under this layer refuses a request that is by none.
async fn written(State(app): State<App>, request: Request, next: Next) -> Response {
  let writes = !matches!(*request.method(), Method::GET | Method::HEAD);
  let response = next.run(request).await;
  if writes && response.status().is_success() {
    app.changes.written();
  }
  response
}

/// On a server with an owner, where reaching it makes the owner, a request is served only for
/// the host it is reached at, so that no other name that points at its address, such as one a
/// page rebinds to it, reaches it from a browser.
async fn own_host(State(app): State<App>, request: Request, next: Next) -> Response {
  let own = config_host(&app.config.url);
  let host = request
    .headers()
    .get(axum::http::header::HOST)
    .and_then(|v| v.to_str().ok())
    .or_else(|| request.uri().authority().map(|a| a.as_str()));
  // Tailscale's Funnel would serve it to the internet, where reaching it makes no one an owner.
  let funnel = request.headers().contains_key("tailscale-funnel-request");
  if !funnel && host.is_some_and(|host| host.eq_ignore_ascii_case(own)) {
    next.run(request).await
  } else {
    (
      axum::http::StatusCode::MISDIRECTED_REQUEST,
      format!("This server is reached at {}.", app.config.url),
    )
      .into_response()
  }
}

/// The host of a URL, with its port where it names one.
fn config_host(url: &str) -> &str {
  let origin = caller::origin_of(url);
  origin.split_once("://").map_or(origin, |(_, host)| host)
}

async fn versioned(mut response: Response) -> Response {
  response
    .headers_mut()
    .insert(VERSION_HEADER, HeaderValue::from(VERSION));
  response
}

/// A path as it is logged: the code of an OTP or an invite, which lets whoever holds it in, as
/// `{code}`.
fn redacted(path: &str) -> String {
  let mut segments: Vec<&str> = path.split('/').collect();
  if let ["", "api", "otp" | "invites", code, ..] = segments[..]
    && code != "redeem"
  {
    segments[3] = "{code}";
  }
  segments.join("/")
}

#[cfg(test)]
#[test]
fn codes_are_not_logged() {
  assert_eq!(redacted("/api/otp/ABCD1234"), "/api/otp/{code}");
  assert_eq!(
    redacted("/api/otp/ABCD1234/approve"),
    "/api/otp/{code}/approve"
  );
  assert_eq!(redacted("/api/invites/k3x9"), "/api/invites/{code}");
  assert_eq!(
    redacted("/api/invites/k3x9/accept"),
    "/api/invites/{code}/accept"
  );
  assert_eq!(redacted("/api/otp/redeem"), "/api/otp/redeem");
  assert_eq!(redacted("/api/invites"), "/api/invites");
  assert_eq!(redacted("/api/sessions/s_1"), "/api/sessions/s_1");
}

async fn logged(request: Request, next: Next) -> Response {
  let (method, path, start) = (
    request.method().clone(),
    redacted(request.uri().path()),
    Instant::now(),
  );
  let response = next.run(request).await;
  tracing::info!(
    "{method} {path} {} {:?}",
    response.status().as_u16(),
    start.elapsed()
  );
  response
}
