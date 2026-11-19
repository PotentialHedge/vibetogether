//! Accounts and their logins: signing in with GitHub, which makes the account, and tokens, each
//! created only by an OTP its person approves on the website.

use std::{
  collections::HashMap,
  sync::Mutex,
  time::{Duration, Instant},
};

use axum::{
  Json,
  extract::State,
  http::{HeaderMap, StatusCode, header},
  response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::{
  CookieJar,
  cookie::{Cookie, SameSite},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use oauth2::{
  AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet, EndpointSet,
  PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, TokenResponse, TokenUrl, basic::BasicClient,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{oneshot, watch};
use vibetogether_protocol::{
  Login, LoginKind, Otp, OtpRedeem, OtpRequest, OtpShown, SYSTEM_NAME, Token, TokenKind,
  is_name_part,
};

use crate::{
  App,
  caller::{Caller, cookie_name, kind_of, origin_of},
  config::Identity,
  db::{self, Db},
  error::{Refusal, Result},
  extract::{Path, Query},
  limits::address_of,
  transport,
};

/// How long a browser's sign-in lasts unused.
pub const SIGN_IN_DAYS: i64 = 90;

/// The hash a login's secret is kept under.
pub fn token_hash(secret: &str) -> String {
  URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()))
}

/// The account GitHub's user `github` has, made with its own group and their general where it
/// is new, and renamed where their login changed. A login is unique on GitHub, but one renamed
/// there keeps its old login here until it signs in again: whoever has the login now takes it,
/// and the one before is named after its GitHub id until then.
pub async fn account_of(
  db: &mut Db,
  github: i64,
  login: &str,
  display_name: &str,
  image: Option<&str>,
) -> Result<String> {
  let login = login.to_lowercase();
  if login == SYSTEM_NAME {
    return Err(Refusal::forbidden(format!(
      "No account is named {SYSTEM_NAME}, the name Vibe Together's system messages are sent under."
    )));
  }
  sqlx::query("UPDATE account SET login = 'github-' || github WHERE login = ? AND github != ?")
    .bind(&login)
    .bind(github)
    .execute(&mut *db)
    .await?;
  let display_name = if display_name.trim().is_empty() {
    &login
  } else {
    display_name
  };
  let existing: Option<String> = sqlx::query_scalar("SELECT id FROM account WHERE github = ?")
    .bind(github)
    .fetch_optional(&mut *db)
    .await?;
  if let Some(id) = existing {
    sqlx::query("UPDATE account SET login = ?, display_name = ?, image = ? WHERE id = ?")
      .bind(&login)
      .bind(display_name)
      .bind(image)
      .bind(&id)
      .execute(&mut *db)
      .await?;
    return Ok(id);
  }
  let (id, group, now) = (db::new_id("u"), db::new_id("g"), db::now());
  sqlx::query(
    "INSERT INTO account (id, github, login, display_name, image, created) VALUES (?, ?, ?, ?, ?, ?)",
  )
  .bind(&id)
  .bind(github)
  .bind(&login)
  .bind(display_name)
  .bind(image)
  .bind(&now)
  .execute(&mut *db)
  .await?;
  sqlx::query(r#"INSERT INTO "group" (id, name, person, created) VALUES (?, ?, ?, ?)"#)
    .bind(&group)
    .bind(&login)
    .bind(&id)
    .bind(&now)
    .execute(&mut *db)
    .await?;
  sqlx::query(r#"INSERT INTO group_member ("group", member, account) VALUES (?, ?, ?)"#)
    .bind(&group)
    .bind(&id)
    .bind(&id)
    .execute(&mut *db)
    .await?;
  db::general_of(db, &group).await?;
  Ok(id)
}

pub async fn sign_up(
  app: &App,
  github: i64,
  login: &str,
  display_name: &str,
  image: Option<&str>,
) -> Result<String> {
  let mut tx = app.db.begin().await?;
  let id = account_of(&mut tx, github, login, display_name, image).await?;
  tx.commit().await?;
  Ok(id)
}

/// A new login of `account`: its secret, which only the database's hash of it stays of.
pub async fn new_login(app: &App, account: &str, kind: LoginKind, name: &str) -> Result<String> {
  let secret = format!("vt_{}", URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()));
  let kind_name = match kind {
    LoginKind::Browser => "browser",
    LoginKind::Agent => "agent",
    LoginKind::Person => "person",
    LoginKind::App => "app",
  };
  let expires = (kind == LoginKind::Browser).then(|| db::from_now(SIGN_IN_DAYS * 86400));
  sqlx::query(
    "INSERT INTO login (id, account, kind, name, token, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  .bind(db::new_id("l"))
  .bind(account)
  .bind(kind_name)
  .bind(name)
  .bind(token_hash(&secret))
  .bind(db::now())
  .bind(expires)
  .execute(&app.db)
  .await?;
  Ok(secret)
}

// Signing in with GitHub, by OAuth's authorization code with PKCE.

/// The cookie that carries a sign-in from its start to GitHub's answer: its state, its PKCE
/// verifier and where it goes on to.
fn pending_cookie(app: &App) -> &'static str {
  if app.config.secure() {
    "__Host-vibetogether.sign_in"
  } else {
    "vibetogether.sign_in"
  }
}

fn cookie<'a>(app: &App, name: &'a str, value: String, age: time::Duration) -> Cookie<'a> {
  Cookie::build((name, value))
    .path("/")
    .http_only(true)
    .secure(app.config.secure())
    .same_site(SameSite::Lax)
    .max_age(age)
    .build()
}

/// The removal of the cookie `name`, as it was set: a `__Host-` one is removed only with `Secure`.
fn removal(app: &App, name: &'static str) -> Cookie<'static> {
  Cookie::build(name)
    .path("/")
    .secure(app.config.secure())
    .build()
}

/// The OAuth client, as GitHub's endpoints and this backend's callback configure it.
type GitHub = BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

fn github(app: &App) -> Result<GitHub> {
  let url = |e: oauth2::url::ParseError| Refusal::bad(e.to_string());
  let Identity::GitHub {
    client_id,
    client_secret,
  } = &app.config.identity
  else {
    return Err(Refusal::not_found(
      "This server has an owner, and no sign-in with GitHub.",
    ));
  };
  Ok(
    BasicClient::new(ClientId::new(client_id.clone()))
      .set_client_secret(ClientSecret::new(client_secret.clone()))
      .set_auth_uri(AuthUrl::new("https://github.com/login/oauth/authorize".into()).map_err(url)?)
      .set_token_uri(
        TokenUrl::new("https://github.com/login/oauth/access_token".into()).map_err(url)?,
      )
      .set_redirect_uri(
        RedirectUrl::new(format!("{}/api/auth/callback/github", app.config.url)).map_err(url)?,
      ),
  )
}

#[derive(Deserialize)]
pub struct SignIn {
  /// The website's path the person lands on once signed in, such as `/account/`.
  callback: Option<String>,
}

/// A path of this host's own: one slash, then anything printable but a second one or a
/// backslash, with no whitespace, which a browser drops, so that `/\t/evil.example` can't become
/// `//evil.example`.
fn own_path(path: &str) -> bool {
  path.starts_with('/')
    && !path.starts_with("//")
    && !path.contains('\\')
    && path.bytes().all(|b| b.is_ascii_graphic())
}

/// Starts signing in: sends the browser to GitHub, which sends it back to `signed_in`; on a
/// server with an owner, signs the browser in as its owner at once.
pub async fn sign_in(
  State(app): State<App>,
  headers: HeaderMap,
  jar: CookieJar,
  Query(query): Query<SignIn>,
) -> Result<Response> {
  app.limits.sign_ins.allow(&headers, 10)?;
  let callback = query
    .callback
    .filter(|c| own_path(c))
    .unwrap_or_else(|| "/account/".into());
  if let Some(owner) = &app.owner {
    // Only the site itself, or the person typing its address, signs in: a page on another site
    // that sends its visitors here would make a login at each visit.
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    if site.is_some_and(|site| !matches!(site, "same-origin" | "none")) {
      return Err(Refusal::forbidden(
        "Sign in from this server's own website.",
      ));
    }
    let jar = signed_in_as(&app, &headers, jar, owner).await?;
    return Ok((jar, Redirect::to(&callback)).into_response());
  }
  let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
  let (url, state) = github(&app)?
    .authorize_url(CsrfToken::new_random)
    .set_pkce_challenge(challenge)
    .url();
  let pending = format!("{} {} {callback}", state.secret(), verifier.secret());
  let jar = jar.add(cookie(
    &app,
    pending_cookie(&app),
    pending,
    time::Duration::minutes(10),
  ));
  Ok((jar, Redirect::to(url.as_str())).into_response())
}

#[derive(Deserialize)]
pub struct Callback {
  code: Option<String>,
  state: Option<String>,
}

/// GitHub's user, as `GET /user` answers it.
#[derive(Deserialize)]
struct GitHubUser {
  id: i64,
  login: String,
  name: Option<String>,
  avatar_url: Option<String>,
}

/// GitHub's answer: signs the person in, as the account GitHub's user has, made where it is new,
/// with a sign-in held in the browser's cookie.
pub async fn signed_in(
  State(app): State<App>,
  headers: HeaderMap,
  jar: CookieJar,
  Query(query): Query<Callback>,
) -> Result<Response> {
  let failed = || Refusal::bad("Signing in failed: start again on the website.");
  let pending = jar
    .get(pending_cookie(&app))
    .map(|c| c.value().to_string())
    .ok_or_else(failed)?;
  let mut parts = pending.splitn(3, ' ');
  let (Some(state), Some(verifier), Some(callback)) = (parts.next(), parts.next(), parts.next())
  else {
    return Err(failed());
  };
  let (Some(code), true) = (query.code, query.state.as_deref() == Some(state)) else {
    return Err(failed());
  };
  let http = |request: oauth2::HttpRequest| {
    let client = app.github.clone();
    async move {
      let request: reqwest::Request = request.try_into()?;
      let response = client.execute(request).await?;
      let mut answer = oauth2::http::Response::builder().status(response.status());
      for (name, value) in response.headers() {
        answer = answer.header(name, value);
      }
      Ok::<_, reqwest::Error>(
        answer
          .body(response.bytes().await?.to_vec())
          .unwrap_or_default(),
      )
    }
  };
  let token = github(&app)?
    .exchange_code(AuthorizationCode::new(code))
    .set_pkce_verifier(PkceCodeVerifier::new(verifier.to_string()))
    .request_async(&http)
    .await
    .map_err(|e| {
      tracing::warn!("GitHub's token: {e}");
      failed()
    })?;
  let user: GitHubUser = app
    .github
    .get("https://api.github.com/user")
    .bearer_auth(token.access_token().secret())
    .header("user-agent", "vibetogether")
    .header("accept", "application/vnd.github+json")
    .send()
    .await
    .and_then(|r| r.error_for_status())
    .map_err(|e| {
      tracing::warn!("GitHub's user: {e}");
      failed()
    })?
    .json()
    .await
    .map_err(|_| failed())?;
  let account = sign_up(
    &app,
    user.id,
    &user.login,
    user.name.as_deref().unwrap_or(&user.login),
    user.avatar_url.as_deref(),
  )
  .await?;
  let jar = signed_in_as(
    &app,
    &headers,
    jar.remove(removal(&app, pending_cookie(&app))),
    &account,
  )
  .await?;
  Ok((jar, Redirect::to(callback)).into_response())
}

/// The browser signed in as `account`: a new sign-in, held in its cookie.
async fn signed_in_as(
  app: &App,
  headers: &HeaderMap,
  jar: CookieJar,
  account: &str,
) -> Result<CookieJar> {
  let user_agent = headers
    .get(axum::http::header::USER_AGENT)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("");
  let secret = new_login(app, account, LoginKind::Browser, &browser_name(user_agent)).await?;
  Ok(jar.add(cookie(
    app,
    cookie_name(app),
    secret,
    time::Duration::days(400),
  )))
}

/// The owner's account, made with its own group at the first start: a server with an owner has
/// this one account alone. It is keyed as GitHub's user 0, which no one on GitHub is.
pub async fn owner_of(app_db: &sqlx::SqlitePool, name: &str) -> Result<String> {
  let mut tx = app_db.begin().await?;
  let id = account_of(&mut tx, 0, name, name, None).await?;
  tx.commit().await?;
  Ok(id)
}

/// A browser login's name, its browser and device as its User-Agent tells them, such as
/// "Safari on iPhone"; whichever part it doesn't tell is left out.
fn browser_name(user_agent: &str) -> String {
  let find = |table: &[(&str, &'static str)]| {
    table
      .iter()
      .find(|(mark, _)| user_agent.contains(mark))
      .map(|(_, name)| *name)
  };
  // The first match wins: each browser's agent also names those it descends from.
  let browser = find(&[
    ("Edg", "Edge"),
    ("OPR/", "Opera"),
    ("Firefox/", "Firefox"),
    ("FxiOS/", "Firefox"),
    ("Chrome/", "Chrome"),
    ("CriOS/", "Chrome"),
    ("Safari/", "Safari"),
  ]);
  let device = find(&[
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("CrOS", "ChromeOS"),
    ("Macintosh", "Mac"),
    ("Windows", "Windows"),
    ("Linux", "Linux"),
  ]);
  match (browser, device) {
    (Some(browser), Some(device)) => format!("{browser} on {device}"),
    (Some(browser), None) => browser.to_string(),
    (None, Some(device)) => format!("a browser on {device}"),
    (None, None) => "a browser".to_string(),
  }
}

/// Signs the browser out: its sign-in is revoked.
pub async fn sign_out(State(app): State<App>, caller: Caller, jar: CookieJar) -> Result<Response> {
  caller.in_browser()?;
  sqlx::query("DELETE FROM login WHERE id = ?")
    .bind(&caller.login)
    .execute(&app.db)
    .await?;
  transport::end_login(&app, &caller.login);
  let jar = jar.remove(removal(&app, cookie_name(&app)));
  Ok((jar, StatusCode::NO_CONTENT).into_response())
}

// Logins.

#[derive(sqlx::FromRow)]
struct LoginRow {
  id: String,
  name: String,
  kind: String,
  created: String,
}

/// The account's logins, oldest first.
pub async fn logins(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Login>>> {
  let rows: Vec<LoginRow> = sqlx::query_as(
    "SELECT id, name, kind, created FROM login WHERE account = ? AND (expires IS NULL OR expires > ?)
     ORDER BY created",
  )
  .bind(&caller.account)
  .bind(db::now())
  .fetch_all(&app.db)
  .await?;
  Ok(Json(
    rows
      .into_iter()
      .map(|row| Login {
        current: row.id == caller.login,
        kind: kind_of(&row.kind),
        id: row.id,
        name: row.name,
        created: row.created,
      })
      .collect(),
  ))
}

/// Revokes a login, which cuts off at once whatever it reached, a receive waiting included: an
/// agent revokes only its own token, the person any.
pub async fn revoke(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  if id != caller.login {
    caller.as_person()?;
  }
  let mut db = app.db.acquire().await?;
  let gone = sqlx::query("DELETE FROM login WHERE id = ? AND account = ?")
    .bind(&id)
    .bind(&caller.account)
    .execute(&mut *db)
    .await?
    .rows_affected();
  if gone == 0 {
    return Err(Refusal::not_found("No such login."));
  }
  transport::end_login(&app, &id);
  caller
    .record(&mut db, "revoke_login", json!({ "id": id }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

// OTPs: a token is created only by an OTP its person approves on the website.

/// How long an OTP waits for its person.
const OTP_LIFETIME: Duration = Duration::from_secs(15 * 60);
/// The most OTPs that wait at once, and of one address. Each has at most one redeem waiting, so
/// this bounds those too.
const MAX_OTPS: usize = 10_000;
const MAX_OTPS_PER_ADDRESS: usize = 10;
/// The most OTPs that wait at once asked by pages on other sites, which any page can make its
/// visitors' browsers ask for: a share of their own, so that such pages never crowd out the
/// command line and agents.
const MAX_PAGE_OTPS: usize = 1_000;
/// Letters and digits that no one misreads for another.
const OTP_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// The OTPs asked for and not yet redeemed, by their code. They are in memory alone: a restart
/// ends them, and their askers ask again.
#[derive(Default)]
pub struct Otps(Mutex<HashMap<String, Pending>>);

struct Pending {
  secret: String,
  kind: TokenKind,
  name: String,
  requested: String,
  from: String,
  /// The web page that asked, by its origin, where a page on another site did.
  origin: Option<String>,
  expires: Instant,
  decision: watch::Sender<Decision>,
  /// The redeem waiting, which a newer one ends by dropping this.
  redeem: Option<oneshot::Sender<()>>,
}

#[derive(Clone, PartialEq)]
enum Decision {
  Waiting,
  /// Approved by the account, by its id and its name.
  Approved(String, String),
  Denied,
}

/// A code as people type it: its letters and digits, in upper case.
fn code_of(given: &str) -> String {
  given
    .chars()
    .filter(char::is_ascii_alphanumeric)
    .map(|c| c.to_ascii_uppercase())
    .collect()
}

impl Otps {
  fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending>> {
    let mut otps = self.0.lock().unwrap();
    let now = Instant::now();
    otps.retain(|_, otp| otp.expires > now);
    otps
  }
}

/// Asks for an OTP, for a token of a kind and name, which the person approves at its link.
pub async fn request_otp(
  State(app): State<App>,
  headers: HeaderMap,
  crate::extract::Json(request): crate::extract::Json<OtpRequest>,
) -> Result<(StatusCode, Json<Otp>)> {
  app.limits.otps.allow(&headers, 10)?;
  if !is_name_part(&request.name) {
    return Err(Refusal::bad(
      "name: lower case letters, digits and hyphens, starting with a letter or digit, such as the machine's name, or an app's.",
    ));
  }
  let from = address_of(&headers);
  // A page on another site asks from its visitor's browser, from their address, so that the
  // OTP looks like their own: it may ask only for an app token, which the OTP page shows with
  // the page's origin. A browser sets `Origin`, which no page forges.
  let origin = headers
    .get(header::ORIGIN)
    .and_then(|v| v.to_str().ok())
    .filter(|origin| *origin != origin_of(&app.config.url))
    .map(str::to_string);
  if origin.is_some() && request.kind != TokenKind::App {
    return Err(Refusal::forbidden(
      "A page on another site asks only for an app token.",
    ));
  }
  let mut otps = app.otps.lock();
  if origin.is_some() && otps.values().filter(|otp| otp.origin.is_some()).count() >= MAX_PAGE_OTPS {
    return Err(Refusal::busy(
      StatusCode::SERVICE_UNAVAILABLE,
      "Too many OTPs of pages wait at once.",
      60,
    ));
  }
  if otps.len() >= MAX_OTPS {
    return Err(Refusal::busy(
      StatusCode::SERVICE_UNAVAILABLE,
      "Too many OTPs wait at once.",
      60,
    ));
  }
  if otps.values().filter(|otp| otp.from == from).count() >= MAX_OTPS_PER_ADDRESS {
    return Err(Refusal::busy(
      StatusCode::TOO_MANY_REQUESTS,
      "Too many OTPs of this address wait at once: use one, or wait until one expires.",
      60,
    ));
  }
  let code = db::random_code(OTP_ALPHABET, 8);
  let secret = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
  // Whoever reaches a server with an owner is its owner, so its OTP approves itself, but not one
  // a page on another site asked for from the owner's browser: that page is not the owner.
  let decision = match (&app.owner, &origin, app.config.owner()) {
    (Some(account), None, Some(name)) => Decision::Approved(account.clone(), name.to_string()),
    _ => Decision::Waiting,
  };
  otps.insert(
    code.clone(),
    Pending {
      secret: token_hash(&secret),
      kind: request.kind,
      name: request.name,
      requested: db::now(),
      from,
      origin,
      expires: Instant::now() + OTP_LIFETIME,
      decision: watch::Sender::new(decision),
      redeem: None,
    },
  );
  let shown = format!("{}-{}", &code[..4], &code[4..]);
  Ok((
    StatusCode::CREATED,
    Json(Otp {
      link: format!("{}/account/otp/?code={shown}", app.config.url),
      code: shown,
      secret,
    }),
  ))
}

/// Redeems an OTP for its token, once its person approved it: it waits for the decision, at most
/// `wait` seconds and never past the OTP's life. One redeem of an OTP waits at a time: a newer
/// one ends the one before.
pub async fn redeem_otp(
  State(app): State<App>,
  crate::extract::Json(request): crate::extract::Json<OtpRedeem>,
) -> Result<Json<Token>> {
  let hash = token_hash(&request.secret);
  let gone = || Refusal::not_found("No such OTP: it expired or was redeemed. Ask for a new one.");
  let (replaced, ends) = oneshot::channel();
  let (code, mut decision, expires) = {
    let mut otps = app.otps.lock();
    let (code, otp) = otps
      .iter_mut()
      .find(|(_, otp)| otp.secret == hash)
      .ok_or_else(gone)?;
    otp.redeem = Some(replaced);
    (code.clone(), otp.decision.subscribe(), otp.expires)
  };
  let wait = request
    .wait
    .map_or(OTP_LIFETIME, Duration::from_secs)
    .min(OTP_LIFETIME);
  let deadline = (Instant::now() + wait).min(expires);
  let decided = tokio::select! {
    biased;
    decided = tokio::time::timeout_at(
      deadline.into(),
      decision.wait_for(|d| *d != Decision::Waiting),
    ) => match decided {
      Ok(Ok(decided)) => decided.clone(),
      Ok(Err(_)) => return Err(gone()),
      Err(_) => {
        return Err(Refusal::new(
          StatusCode::REQUEST_TIMEOUT,
          "Not approved yet: ask again.",
        ));
      }
    },
    _ = ends => {
      return Err(Refusal::conflict(
        "A newer redeem of this OTP took over from this one.",
      ));
    }
  };
  let Some(otp) = app.otps.lock().remove(&code) else {
    return Err(gone());
  };
  match decided {
    Decision::Approved(account, person) => {
      let kind = match otp.kind {
        TokenKind::Agent => LoginKind::Agent,
        TokenKind::Person => LoginKind::Person,
        TokenKind::App => LoginKind::App,
      };
      let token = new_login(&app, &account, kind, &otp.name).await?;
      let login = sqlx::query_scalar("SELECT id FROM login WHERE token = ?")
        .bind(token_hash(&token))
        .fetch_one(&app.db)
        .await?;
      Ok(Json(Token {
        token,
        kind: otp.kind,
        account: person,
        login,
      }))
    }
    _ => Err(Refusal::forbidden("The person denied this OTP.")),
  }
}

/// An OTP as its person sees it before deciding.
pub async fn show_otp(
  State(app): State<App>,
  caller: Caller,
  Path(code): Path<String>,
) -> Result<Json<OtpShown>> {
  caller.in_browser()?;
  let otps = app.otps.lock();
  let otp = otps
    .get(&code_of(&code))
    .filter(|otp| *otp.decision.borrow() == Decision::Waiting)
    .ok_or_else(|| {
      Refusal::not_found("No such OTP: it expired or was decided. Ask for a new one.")
    })?;
  Ok(Json(OtpShown {
    code,
    name: otp.name.clone(),
    kind: otp.kind,
    requested: otp.requested.clone(),
    from: otp.from.clone(),
    origin: otp.origin.clone(),
  }))
}

fn decide(app: &App, caller: &Caller, code: &str, decision: Decision) -> Result<StatusCode> {
  caller.in_browser()?;
  let otps = app.otps.lock();
  let otp = otps
    .get(&code_of(code))
    .filter(|otp| *otp.decision.borrow() == Decision::Waiting)
    .ok_or_else(|| {
      Refusal::not_found("No such OTP: it expired or was decided. Ask for a new one.")
    })?;
  otp.decision.send_replace(decision);
  Ok(StatusCode::NO_CONTENT)
}

/// The person approves an OTP: its asker gets a token of the account.
pub async fn approve_otp(
  State(app): State<App>,
  caller: Caller,
  Path(code): Path<String>,
) -> Result<StatusCode> {
  let approved = Decision::Approved(caller.account.clone(), caller.person.clone());
  decide(&app, &caller, &code, approved)
}

pub async fn deny_otp(
  State(app): State<App>,
  caller: Caller,
  Path(code): Path<String>,
) -> Result<StatusCode> {
  decide(&app, &caller, &code, Decision::Denied)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_callback_is_a_path_of_this_host() {
    assert!(own_path("/account/"));
    assert!(own_path("/invite/?code=abc"));
    for path in [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/ /evil.example",
      "/\n/evil.example",
      "https://evil.example",
      "/é",
    ] {
      assert!(!own_path(path), "{path:?}");
    }
  }

  #[test]
  fn a_browser_login_is_named_by_its_browser_and_device() {
    for (agent, name) in [
      (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        "Safari on iPhone",
      ),
      (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
        "Firefox on Mac",
      ),
      (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
        "Edge on Windows",
      ),
      (
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
        "Chrome on Android",
      ),
      (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
        "Chrome on iPhone",
      ),
      ("curl/8.0", "a browser"),
      ("", "a browser"),
    ] {
      assert_eq!(browser_name(agent), name);
    }
  }
}
