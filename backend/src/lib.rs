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
mod sessions;
mod transport;

use std::{ops::Deref, sync::Arc, time::Instant};

use axum::{
  Router,
  extract::{Request, State},
  http::{HeaderValue, Method},
  middleware::{self, Next},
  response::Response,
  routing::{get, post, put},
};
use sqlx::SqlitePool;
use vibetogether_protocol::{LoginKind, VERSION, VERSION_HEADER};

pub use crate::config::Config;

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
    let app = Self(Arc::new(Shared {
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
  /// query, headers or body, which hold tokens and links. Every answer names the API's version.
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
      .route("/agents/{id}", axum::routing::patch(account::rename_agent))
      .route("/agents/{id}/archive", post(account::archive_agent))
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
      .route("/auth/github", get(auth::sign_in))
      .route("/auth/github/callback", get(auth::signed_in))
      .route("/auth/sign-out", post(auth::sign_out))
      .route("/otp/{code}", get(auth::show_otp))
      .route("/otp/{code}/approve", post(auth::approve_otp))
      .route("/otp/{code}/deny", post(auth::deny_otp))
      .layer(middleware::from_fn_with_state(self.clone(), written))
      // Asking for an OTP and redeeming it is anyone's, and changes nothing anyone waits on.
      .route("/otp", post(auth::request_otp))
      .route("/otp/redeem", post(auth::redeem_otp));
    Router::new()
      .nest("/api", api)
      .layer(middleware::from_fn(logged))
      .layer(middleware::map_response(versioned))
      .with_state(self.clone())
  }
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

async fn versioned(mut response: Response) -> Response {
  response
    .headers_mut()
    .insert(VERSION_HEADER, HeaderValue::from(VERSION));
  response
}

async fn logged(request: Request, next: Next) -> Response {
  let (method, path, start) = (
    request.method().clone(),
    request.uri().path().to_string(),
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
