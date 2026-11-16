//! Who a request is made by: a login of an account, by the browser's cookie or a token.

use axum::{
  extract::{FromRequestParts, OptionalFromRequestParts},
  http::{Method, StatusCode, header, request::Parts},
};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use serde_json::Value;
use vibetogether_protocol::{LoginKind, Named};

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
  /// The agent an agent token's request names, by its id, with its name as `<account>/<agent>`.
  pub agent: Option<Named>,
}

/// The agent a request names, as `agent=<id>`.
#[derive(Deserialize)]
struct AgentParam {
  agent: Option<String>,
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
/// browser's. A request by the cookie comes from the website's own pages: a change by its
/// `Origin`, anything else, such as a receive that moves the read position, by
/// `Sec-Fetch-Site: same-origin`, which a browser sets. A browser's sign-in lasts 90 days from when it was last used. An agent token's
/// request names its agent with `agent=<id>`, unless `unnamed`; the person's names none.
async fn caller_of(app: &App, parts: &Parts, unnamed: bool) -> Result<Option<Caller>> {
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
  if browser {
    let header = |name| parts.headers.get(name).and_then(|v| v.to_str().ok());
    let from_site = match parts.method {
      Method::GET | Method::HEAD | Method::OPTIONS => {
        header(header::HeaderName::from_static("sec-fetch-site")) == Some("same-origin")
      }
      _ => header(header::ORIGIN) == Some(origin_of(&app.config.url)),
    };
    if !from_site {
      return Err(Refusal::forbidden(
        "A request by the person's cookie comes from the website.",
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
  let named = axum::extract::Query::<AgentParam>::try_from_uri(&parts.uri)
    .map_err(|e| Refusal::bad(e.body_text()))?
    .0
    .agent;
  let agent = match (kind, named) {
    (LoginKind::Agent, Some(id)) => {
      let found: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT name, holder, archived FROM agent WHERE id = ? AND account = ?")
          .bind(&id)
          .bind(&row.account)
          .fetch_optional(&mut *db)
          .await?;
      let (name, holder, archived) = found.ok_or_else(|| {
        Refusal::not_found("No such agent of this account: create_agent creates one.")
      })?;
      if archived.is_some() {
        return Err(Refusal::forbidden(
          "This agent is archived: it acts no more.",
        ));
      }
      // No call acts as an agent another token holds, so none writes under its name.
      if let Some(holder) = holder.filter(|holder| *holder != row.id)
        && crate::transport::login_lasts(&mut db, &holder).await?
      {
        return Err(Refusal::conflict(
          "Another login holds this agent, which is one mind at a time: it takes it only once that login is revoked.",
        ));
      }
      Some(Named {
        id,
        name: format!("{}/{name}", row.person),
      })
    }
    (LoginKind::Agent, None) if unnamed => None,
    (LoginKind::Agent, None) => {
      return Err(Refusal::bad(
        "An agent token acts only for agents: name yours by its id with agent=<id>, such as agent=a_k3x9q2mf, which create_agent gives.",
      ));
    }
    (_, Some(_)) => {
      return Err(Refusal::bad(
        "The person acts as themselves, with no agent.",
      ));
    }
    (_, None) => None,
  };
  Ok(Some(Caller {
    account: row.account,
    person: row.person,
    login: row.id,
    kind,
    name: row.name,
    agent,
  }))
}

fn unauthorized() -> Refusal {
  Refusal::new(
    StatusCode::UNAUTHORIZED,
    "Sign in on the website, or send a token as Authorization: Bearer <token>.",
  )
}

impl FromRequestParts<App> for Caller {
  type Rejection = Refusal;

  async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self> {
    caller_of(app, parts, false).await?.ok_or_else(unauthorized)
  }
}

/// A caller whose agent token may name no agent: only to create one, which it then names.
pub struct Unnamed(pub Caller);

impl FromRequestParts<App> for Unnamed {
  type Rejection = Refusal;

  async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self> {
    Ok(Unnamed(
      caller_of(app, parts, true)
        .await?
        .ok_or_else(unauthorized)?,
    ))
  }
}

impl OptionalFromRequestParts<App> for Caller {
  type Rejection = Refusal;

  async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Option<Self>> {
    caller_of(app, parts, false).await
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
  /// The participant acting, by name: the agent an agent token names, as `<account>/<agent>`,
  /// else the person.
  pub fn actor(&self) -> &str {
    self
      .agent
      .as_ref()
      .map_or(&self.person, |agent| &agent.name)
  }

  /// The participant acting, by its id: the agent an agent token names, else the person by
  /// their account's id. It decides what the request sees: an agent sees only its groups.
  pub fn who(&self) -> &str {
    self.agent.as_ref().map_or(&self.account, |agent| &agent.id)
  }

  /// Refuses a token: only the person does this, signed in in the browser.
  pub fn in_browser(&self) -> Result<()> {
    match self.kind {
      LoginKind::Browser => Ok(()),
      _ => Err(Refusal::forbidden(
        "Only the person does this, signed in in the browser, never with a token.",
      )),
    }
  }

  /// Refuses an agent token: only the person does this, in the browser or with a person token.
  pub fn as_person(&self) -> Result<()> {
    match self.kind {
      LoginKind::Agent => Err(Refusal::forbidden(
        "Only the person does this, in the browser or with a person token, never an agent.",
      )),
      _ => Ok(()),
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
  /// arguments, and the agent that made it. The person, in the browser, is not recorded, nor is
  /// what is said in a session, which its log holds.
  pub async fn record(&self, db: &mut Db, operation: &str, arguments: Value) -> Result<()> {
    if self.kind == LoginKind::Browser {
      return Ok(());
    }
    let mut arguments = arguments.to_string();
    arguments.truncate(arguments.floor_char_boundary(2000));
    sqlx::query(
      "INSERT INTO activity (account, login, name, agent, operation, arguments, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&self.account)
    .bind(&self.login)
    .bind(&self.name)
    .bind(self.agent.as_ref().map(|a| &a.id))
    .bind(operation)
    .bind(arguments)
    .bind(db::now())
    .execute(db)
    .await?;
    Ok(())
  }
}
