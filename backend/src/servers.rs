//! The other servers an owner is on: a server with an owner keeps an app token for each, so
//! that every client of the owner's, such as the website opened from this server, reaches them
//! through it. Trust flows from the more trusted side: this server asks the other for an OTP, as
//! any client does, and the other never learns what asked.

use std::time::Duration;

use axum::{Json, extract::State, http::StatusCode};
use serde_json::json;
use vibetogether_client::Client;
use vibetogether_protocol::{
  AddServer, Identity, OtpRequest, Server, ServerInfo, ServerOtp, TokenKind,
};

use crate::{
  App,
  caller::{Caller, origin_of},
  db,
  error::{Refusal, Result},
  extract::Path,
};

/// What this server is: anyone's to ask, so that a client knows how its people sign in.
pub async fn info(State(app): State<App>) -> Json<ServerInfo> {
  Json(ServerInfo {
    identity: match app.config.owner() {
      Some(_) => Identity::Owner,
      None => Identity::Github,
    },
    owner: app.config.owner().map(str::to_string),
  })
}

/// Only the owner, in the browser or with a person token, on a server with an owner.
fn owner(app: &App, caller: &Caller) -> Result<()> {
  if app.owner.is_none() {
    return Err(Refusal::not_found(
      "Only a server with an owner keeps tokens for other servers.",
    ));
  }
  caller.as_person()
}

#[derive(sqlx::FromRow)]
struct Row {
  id: String,
  url: String,
  name: String,
  token: String,
  login: String,
  added: String,
}

pub async fn list(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Server>>> {
  owner(&app, &caller)?;
  let rows: Vec<Row> = sqlx::query_as(
    "SELECT id, url, name, token, login, added FROM server WHERE account = ? ORDER BY added",
  )
  .bind(&caller.account)
  .fetch_all(&app.db)
  .await?;
  Ok(Json(
    rows
      .into_iter()
      .map(|row| Server {
        id: row.id,
        url: row.url,
        account: row.name,
        token: row.token,
        login: row.login,
        added: row.added,
      })
      .collect(),
  ))
}

/// A server's URL as it is kept: its origin, `https://host`, plain HTTP only for loopback.
fn server_url(given: &str) -> Result<String> {
  let given = given.trim();
  let given = if given.contains("://") {
    given.to_string()
  } else {
    format!("https://{given}")
  };
  let bad =
    || Refusal::bad("url: a server's origin, such as https://vibetogether.potentialhedge.com.");
  let url = url::Url::parse(&given).map_err(|_| bad())?;
  let loopback = matches!(
    url.host(),
    Some(url::Host::Domain("localhost"))
      | Some(url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST))
      | Some(url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST))
  );
  let scheme = url.scheme() == "https" || url.scheme() == "http" && loopback;
  if !scheme || url.path() != "/" || url.query().is_some() || !url.username().is_empty() {
    return Err(bad());
  }
  Ok(url.origin().ascii_serialization())
}

/// This server's name as a login's name elsewhere: its host's first label.
fn login_name(app: &App) -> String {
  let host = origin_of(&app.config.url)
    .split_once("://")
    .map_or("", |(_, host)| host);
  let label: String = host
    .split(['.', ':'])
    .next()
    .unwrap_or_default()
    .to_lowercase();
  if vibetogether_protocol::is_name_part(&label) {
    label
  } else {
    "server".into()
  }
}

/// Adds a server: asks it for an OTP of an app token, which the owner approves at its link,
/// and keeps the token once approved, redeeming it in the background within the OTP's life.
pub async fn add(
  State(app): State<App>,
  caller: Caller,
  crate::extract::Json(request): crate::extract::Json<AddServer>,
) -> Result<(StatusCode, Json<ServerOtp>)> {
  owner(&app, &caller)?;
  let url = server_url(&request.url)?;
  if url == origin_of(&app.config.url) {
    return Err(Refusal::bad("This is this server itself."));
  }
  let client = Client::new(&url, None);
  let otp = client
    .request_otp(&OtpRequest {
      // An app token sends and reads in the owner's sessions there, and lets no one in: whoever
      // reaches this server is its owner, the owner's agents too, so a token kept here is
      // theirs as well, and none of them becomes the person elsewhere through it.
      kind: TokenKind::App,
      name: login_name(&app),
    })
    .await
    .map_err(|e| Refusal::bad(format!("{url} gave no OTP: {e}")))?;
  // The owner follows the link, so it leads to that server's own site, and nowhere else.
  if !otp.link.starts_with(&format!("{url}/")) {
    return Err(Refusal::bad(format!("{url} gave an OTP link elsewhere.")));
  }
  let (secret, account) = (otp.secret, caller.account.clone());
  let (app2, url2) = (app.clone(), url.clone());
  tokio::spawn(async move {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);
    let token = loop {
      match client.redeem_otp(&secret).await {
        Ok(token) => break token,
        Err(e) if e.status() == Some(408) || e.transient() => {
          if tokio::time::Instant::now() >= deadline {
            return;
          }
          if e.status() != Some(408) {
            tokio::time::sleep(Duration::from_secs(5)).await;
          }
        }
        Err(e) => {
          tracing::info!("{url2}'s OTP ended: {e}");
          return;
        }
      }
    };
    let stored = sqlx::query(
      "INSERT INTO server (id, account, url, name, token, login, added) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account, url) DO UPDATE SET name = excluded.name, token = excluded.token,
       login = excluded.login, added = excluded.added",
    )
    .bind(db::new_id("v"))
    .bind(&account)
    .bind(&url2)
    .bind(&token.account)
    .bind(&token.token)
    .bind(&token.login)
    .bind(db::now())
    .execute(&app2.db)
    .await;
    match stored {
      Ok(_) => app2.changes.written(),
      Err(e) => tracing::warn!("keeping {url2}'s token: {e}"),
    }
  });
  let mut db = app.db.acquire().await?;
  caller
    .record(&mut db, "add_server", json!({ "url": url }))
    .await?;
  Ok((
    StatusCode::CREATED,
    Json(ServerOtp {
      code: otp.code,
      link: otp.link,
    }),
  ))
}

/// Removes a server, and revokes its token there where it still reaches it.
pub async fn remove(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  owner(&app, &caller)?;
  let row: Option<(String, String, String)> =
    sqlx::query_as("DELETE FROM server WHERE id = ? AND account = ? RETURNING url, token, login")
      .bind(&id)
      .bind(&caller.account)
      .fetch_optional(&app.db)
      .await?;
  let (url, token, login) = row.ok_or_else(|| Refusal::not_found("No such server."))?;
  if let Err(e) = Client::new(&url, Some(token)).revoke_login(&login).await {
    tracing::info!("revoking the token at {url}: {e}");
  }
  let mut db = app.db.acquire().await?;
  caller
    .record(&mut db, "remove_server", json!({ "url": url }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[test]
fn a_server_is_named_by_its_origin() {
  assert_eq!(
    server_url("vibetogether.potentialhedge.com/").unwrap(),
    "https://vibetogether.potentialhedge.com"
  );
  assert_eq!(
    server_url("https://a.example").unwrap(),
    "https://a.example"
  );
  assert_eq!(
    server_url("http://127.0.0.1:3000").unwrap(),
    "http://127.0.0.1:3000"
  );
  for bad in [
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com:80",
    "http://a.example",
    "https://a.example/x",
    "ftp://a.example",
    "https://",
  ] {
    assert!(server_url(bad).is_err(), "{bad}");
  }
}
