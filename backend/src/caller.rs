//! Who a request is made by: a login of an account, by the browser's cookie or a token.

use axum::{
  extract::{FromRequestParts, OptionalFromRequestParts},
  http::{Method, StatusCode, header, request::Parts},
};
use axum_extra::extract::CookieJar;
use serde_json::Value;
use vibetogether_protocol::LoginKind;

use crate::{
  App, auth,
  db::{self, Db},
  error::{Refusal, Result},
};

/// A login, as a request is made by it.
#[derive(Clone, Debug)]
pub struct Caller {
  /// The account's id, which is the person's id as a participant.
  pub account: String,
  /// The account's name, its GitHub login in lower case.
  pub person: String,
  /// The login's id.
  pub login: String,
  pub kind: LoginKind,
  /// The login's name, as its OTP gave it.
  pub name: String,
}

/// The name of the cookie a browser's sign-in is held in: over HTTPS `__Host-`, Secure and for
/// this host alone, since other sites under the same domain are other people's.
pub fn cookie_name(app: &App) -> &'static str {
  if app.config.secure() {
    "__Host-vibetogether.session_token"
  } else {
    "vibetogether.session_token"
  }
}

/// The origin the website is served from, which every change by the cookie comes from.
fn origin_of(url: &str) -> &str {
  let host = url.find("://").map_or(0, |i| i + 3);
  url[host..].find('/').map_or(url, |i| &url[..host + i])
}

#[derive(sqlx::FromRow)]
struct LoginRow {
  id: String,
  kind: String,
  name: String,
  expires: Option<String>,
  account: String,
  person: String,
}

pub fn kind_of(kind: &str) -> LoginKind {
  match kind {
    "agent" => LoginKind::Agent,
    "person" => LoginKind::Person,
    _ => LoginKind::Browser,
  }
}

/// The login a request is made by, while it lasts: a bearer token is a token's, a cookie a
/// browser's. A browser's sign-in lasts 90 days from when it was last used.
async fn caller_of(app: &App, parts: &Parts) -> Result<Option<Caller>> {
  let bearer = parts
    .headers
    .get(header::AUTHORIZATION)
    .and_then(|v| v.to_str().ok())
    .and_then(|v| v.split_once(' '))
    .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
    .map(|(_, token)| token.trim().to_string());
  let cookie = CookieJar::from_headers(&parts.headers)
    .get(cookie_name(app))
    .map(|c| c.value().to_string());
  let (secret, browser) = match (bearer, cookie) {
    (Some(token), _) => (token, false),
    (None, Some(cookie)) => (cookie, true),
    (None, None) => return Ok(None),
  };
  if browser && !matches!(parts.method, Method::GET | Method::HEAD | Method::OPTIONS) {
    let origin = parts
      .headers
      .get(header::ORIGIN)
      .and_then(|v| v.to_str().ok());
    if origin != Some(origin_of(&app.config.url)) {
      return Err(Refusal::forbidden(
        "A change by the person comes from the website.",
      ));
    }
  }
  let mut db = app.db.acquire().await?;
  let row: Option<LoginRow> = sqlx::query_as(
    "SELECT l.id, l.kind, l.name, l.expires, a.id AS account, a.login AS person
     FROM login l JOIN account a ON a.id = l.account WHERE l.token = ?",
  )
  .bind(auth::token_hash(&secret))
  .fetch_optional(&mut *db)
  .await?;
  let now = db::now();
  let Some(row) = row.filter(|row| row.expires.as_ref().is_none_or(|e| *e > now)) else {
    return Ok(None);
  };
  let kind = kind_of(&row.kind);
  if (kind == LoginKind::Browser) != browser {
    return Ok(None);
  }
  if let Some(expires) = &row.expires
    && *expires < db::from_now(auth::SIGN_IN_DAYS * 86400 - 86400)
  {
    sqlx::query("UPDATE login SET expires = ? WHERE id = ?")
      .bind(db::from_now(auth::SIGN_IN_DAYS * 86400))
      .bind(&row.id)
      .execute(&mut *db)
      .await?;
  }
  Ok(Some(Caller {
    account: row.account,
    person: row.person,
    login: row.id,
    kind,
    name: row.name,
  }))
}

impl FromRequestParts<App> for Caller {
  type Rejection = Refusal;

  async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self> {
    caller_of(app, parts).await?.ok_or_else(|| {
      Refusal::new(
        StatusCode::UNAUTHORIZED,
        "Sign in on the website, or send a token as Authorization: Bearer <token>.",
      )
    })
  }
}

impl OptionalFromRequestParts<App> for Caller {
  type Rejection = Refusal;

  async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Option<Self>> {
    caller_of(app, parts).await
  }
}

/// The changes limited per account and hour for a token, each on its own, so that an agent
/// talked into letting someone in can't spread fast.
const LIMITED: [(&str, i64); 3] = [
  ("add_friend", 20),
  ("add_group_member", 20),
  ("create_invite", 20),
];

impl Caller {
  /// Refuses a token: only the person does this, signed in in the browser.
  pub fn in_browser(&self) -> Result<()> {
    match self.kind {
      LoginKind::Browser => Ok(()),
      _ => Err(Refusal::forbidden(
        "Only the person does this, signed in in the browser, never with a token.",
      )),
    }
  }

  /// Refuses `operation` by a token that did it too often this hour.
  pub async fn limit(&self, db: &mut Db, operation: &str) -> Result<()> {
    let Some((_, most)) = LIMITED.iter().find(|(op, _)| *op == operation) else {
      return Ok(());
    };
    if self.kind == LoginKind::Browser {
      return Ok(());
    }
    let done: i64 = sqlx::query_scalar(
      "SELECT count(*) FROM activity WHERE account = ? AND operation = ? AND created > ?",
    )
    .bind(&self.account)
    .bind(operation)
    .bind(db::from_now(-3600))
    .fetch_one(db)
    .await?;
    if done >= *most {
      return Err(Refusal::busy(
        StatusCode::TOO_MANY_REQUESTS,
        format!(
          "Agents do this at most {most} times an hour for one account: your person can do it on the website meanwhile."
        ),
        3600,
      ));
    }
    Ok(())
  }

  /// Records a change a token made to the account, for its person to see: the operation and its
  /// arguments. The person, in the browser, is not recorded, nor is what is said in a session,
  /// which its log holds.
  pub async fn record(&self, db: &mut Db, operation: &str, arguments: Value) -> Result<()> {
    if self.kind == LoginKind::Browser {
      return Ok(());
    }
    let mut arguments = arguments.to_string();
    arguments.truncate(arguments.floor_char_boundary(2000));
    sqlx::query(
      "INSERT INTO activity (account, login, name, operation, arguments, created) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&self.account)
    .bind(&self.login)
    .bind(&self.name)
    .bind(operation)
    .bind(arguments)
    .bind(db::now())
    .execute(db)
    .await?;
    Ok(())
  }
}
