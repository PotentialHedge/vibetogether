//! Vibe Together's client library: every operation of the API, as `vibetogether-protocol`
//! defines it, as one method of `Client`. It builds natively and for the web, where the website
//! calls it through its WebAssembly bindings (`web`).
//!
//! A client acts as one participant: the person, by the browser's cookie or a person token, or
//! one of their agents, by an agent token and the agent's id, which the client names in every
//! request a participant makes.

#[cfg(target_arch = "wasm32")]
mod web;

use reqwest::{Method, RequestBuilder, Response, StatusCode, header};
use serde::{Serialize, de::DeserializeOwned};
use vibetogether_protocol::*;

/// Why a call failed.
#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
  /// The backend refused it, with a status and one sentence on why.
  #[error("{message}")]
  Refused {
    status: u16,
    message: String,
    /// Seconds after which asking again may succeed.
    retry_after: Option<u64>,
  },
  /// The backend was not reached, or its answer not read.
  #[error("{0}")]
  Network(String),
  /// The call itself is malformed, such as a path parameter that is `.` or `..`.
  #[error("{0}")]
  Usage(String),
}

impl Error {
  /// The status of a refusal.
  pub fn status(&self) -> Option<u16> {
    match self {
      Error::Refused { status, .. } => Some(*status),
      _ => None,
    }
  }

  /// Whether asking again may succeed: the network failed, or the backend is restarting or busy.
  pub fn transient(&self) -> bool {
    match self {
      Error::Network(_) => true,
      Error::Refused { status, .. } => matches!(status, 408 | 429 | 502 | 503 | 504),
      Error::Usage(_) => false,
    }
  }
}

impl From<reqwest::Error> for Error {
  fn from(error: reqwest::Error) -> Self {
    Error::Network(error.to_string())
  }
}

pub type Result<T> = std::result::Result<T, Error>;

/// An entry's payload, as fetched.
#[derive(Debug, Clone)]
pub struct Payload {
  /// Its MIME type.
  pub ty: String,
  pub filename: Option<String>,
  pub bytes: Vec<u8>,
}

/// A client of the backend at `server`, such as `https://vibetogether.potentialhedge.com`.
#[derive(Clone, Debug)]
pub struct Client {
  http: reqwest::Client,
  server: String,
  token: Option<String>,
  agent: Option<String>,
}

/// A path parameter, which never reaches another route: `.` and `..` are refused, and the rest is
/// percent-encoded.
fn segment(part: &str) -> Result<String> {
  if part.is_empty() || part == "." || part == ".." {
    return Err(Error::Usage(format!("{part:?} is no id or name.")));
  }
  Ok(
    part
      .bytes()
      .map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
          (b as char).to_string()
        }
        b => format!("%{b:02X}"),
      })
      .collect(),
  )
}

impl Client {
  /// A client with `token`, or with none, as a browser is, whose cookie the web build sends.
  pub fn new(server: &str, token: Option<String>) -> Self {
    Self::with_http(reqwest::Client::new(), server, token)
  }

  /// A client over its own HTTP client, such as one with headers of its own.
  pub fn with_http(http: reqwest::Client, server: &str, token: Option<String>) -> Self {
    Self {
      http,
      server: server.trim_end_matches('/').to_string(),
      token,
      agent: None,
    }
  }

  /// The client acting as the agent `agent`, by its id, or as the person where it is none.
  pub fn acting_as(mut self, agent: Option<String>) -> Self {
    self.agent = agent;
    self
  }

  pub fn server(&self) -> &str {
    &self.server
  }

  pub fn agent(&self) -> Option<&str> {
    self.agent.as_deref()
  }

  fn request(&self, method: Method, path: &[&str]) -> Result<RequestBuilder> {
    let mut url = format!("{}/api", self.server);
    for part in path {
      url.push('/');
      url += &segment(part)?;
    }
    let mut request = self.http.request(method, url);
    if let Some(token) = &self.token {
      request = request.bearer_auth(token);
    }
    Ok(request)
  }

  /// The agent this client acts as, as the query of a participant's request.
  fn agent_query(&self) -> AgentQuery {
    AgentQuery {
      agent: self.agent.clone(),
    }
  }

  async fn answer(response: Response) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
      return Ok(response);
    }
    let retry_after = response
      .headers()
      .get(header::RETRY_AFTER)
      .and_then(|v| v.to_str().ok())
      .and_then(|v| v.parse().ok());
    let text = response.text().await.unwrap_or_default();
    let message = match text.trim() {
      "" => status.canonical_reason().unwrap_or("Refused.").to_string(),
      text => text.to_string(),
    };
    Err(Error::Refused {
      status: status.as_u16(),
      message,
      retry_after,
    })
  }

  async fn send<T: DeserializeOwned>(request: RequestBuilder) -> Result<T> {
    let response = Self::answer(request.send().await?).await?;
    let no_content = response.status() == StatusCode::NO_CONTENT;
    let bytes = response.bytes().await?;
    let json: &[u8] = if no_content || bytes.is_empty() {
      b"null"
    } else {
      &bytes
    };
    serde_json::from_slice(json).map_err(|e| Error::Network(format!("unreadable answer: {e}")))
  }

  async fn get<T: DeserializeOwned>(&self, path: &[&str]) -> Result<T> {
    Self::send(self.request(Method::GET, path)?).await
  }

  async fn query<T: DeserializeOwned>(&self, path: &[&str], query: &impl Serialize) -> Result<T> {
    Self::send(self.request(Method::GET, path)?.query(query)).await
  }

  async fn json<T: DeserializeOwned>(
    &self,
    method: Method,
    path: &[&str],
    body: &impl Serialize,
  ) -> Result<T> {
    Self::send(self.request(method, path)?.json(body)).await
  }

  async fn bare<T: DeserializeOwned>(&self, method: Method, path: &[&str]) -> Result<T> {
    Self::send(self.request(method, path)?).await
  }

  // The account.

  pub async fn me(&self) -> Result<Account> {
    self.get(&["me"]).await
  }

  /// Everything the account sees at once; with `version`, once it differs from it, at most
  /// `wait` seconds.
  pub async fn overview(&self, query: &OverviewQuery) -> Result<Overview> {
    self.query(&["overview"], query).await
  }

  pub async fn activity(&self) -> Result<Vec<Activity>> {
    self.get(&["activity"]).await
  }

  /// Deletes the account: only the person, in the browser.
  pub async fn delete_account(&self) -> Result<()> {
    self.bare(Method::DELETE, &["me"]).await
  }

  // Groups and projects.

  pub async fn groups(&self) -> Result<Vec<Group>> {
    self.get(&["groups"]).await
  }

  pub async fn create_group(&self, name: &str) -> Result<Group> {
    self
      .json(Method::POST, &["groups"], &NameBody { name: name.into() })
      .await
  }

  pub async fn rename_group(&self, id: &str, name: &str) -> Result<Group> {
    self
      .json(
        Method::PATCH,
        &["groups", id],
        &NameBody { name: name.into() },
      )
      .await
  }

  pub async fn delete_group(&self, id: &str) -> Result<()> {
    self.bare(Method::DELETE, &["groups", id]).await
  }

  pub async fn add_member(&self, group: &str, name: &str) -> Result<Group> {
    self
      .bare(Method::PUT, &["groups", group, "members", name])
      .await
  }

  pub async fn remove_member(&self, group: &str, name: &str) -> Result<()> {
    self
      .bare(Method::DELETE, &["groups", group, "members", name])
      .await
  }

  pub async fn projects(&self) -> Result<Vec<Project>> {
    self.get(&["projects"]).await
  }

  pub async fn create_project(&self, project: &CreateProject) -> Result<Project> {
    self.json(Method::POST, &["projects"], project).await
  }

  pub async fn change_project(&self, id: &str, change: &ChangeProject) -> Result<Project> {
    self.json(Method::PATCH, &["projects", id], change).await
  }

  pub async fn delete_project(&self, id: &str) -> Result<()> {
    self.bare(Method::DELETE, &["projects", id]).await
  }

  // Agents and statuses.

  /// The account's agents, the archived included.
  pub async fn agents(&self) -> Result<Vec<Agent>> {
    self.get(&["agents"]).await
  }

  pub async fn create_agent(&self, name: &str) -> Result<Agent> {
    self
      .json(Method::POST, &["agents"], &NameBody { name: name.into() })
      .await
  }

  pub async fn rename_agent(&self, id: &str, name: &str) -> Result<Agent> {
    self
      .json(
        Method::PATCH,
        &["agents", id],
        &NameBody { name: name.into() },
      )
      .await
  }

  pub async fn archive_agent(&self, id: &str) -> Result<()> {
    self.bare(Method::POST, &["agents", id, "archive"]).await
  }

  /// Sets the status of the participant this client acts as; empty clears it.
  pub async fn set_status(&self, text: &str) -> Result<()> {
    let request = self
      .request(Method::PUT, &["status"])?
      .query(&self.agent_query());
    Self::send(request.json(&StatusBody { text: text.into() })).await
  }

  // Sessions.

  pub async fn sessions(&self) -> Result<Vec<Session>> {
    self.get(&["sessions"]).await
  }

  pub async fn create_session(&self, session: &CreateSession) -> Result<Session> {
    self.json(Method::POST, &["sessions"], session).await
  }

  pub async fn session(&self, id: &str) -> Result<Session> {
    self.get(&["sessions", id]).await
  }

  pub async fn rename_session(&self, id: &str, name: &str) -> Result<Session> {
    self
      .json(
        Method::PATCH,
        &["sessions", id],
        &NameBody { name: name.into() },
      )
      .await
  }

  pub async fn delete_session(&self, id: &str) -> Result<()> {
    self.bare(Method::DELETE, &["sessions", id]).await
  }

  /// Everyone in the session, by name.
  pub async fn participants(
    &self,
    id: &str,
  ) -> Result<std::collections::BTreeMap<String, Participant>> {
    self.get(&["sessions", id, "participants"]).await
  }

  pub async fn join(&self, id: &str) -> Result<Joined> {
    Self::send(
      self
        .request(Method::POST, &["sessions", id, "participants"])?
        .query(&self.agent_query()),
    )
    .await
  }

  pub async fn leave(&self, id: &str) -> Result<Left> {
    Self::send(
      self
        .request(Method::DELETE, &["sessions", id, "participants"])?
        .query(&self.agent_query()),
    )
    .await
  }

  /// Sends `payload` of type `ty`, such as a message of `text/markdown; ping="ben"`, named as a
  /// file where `filename` is given.
  pub async fn send_entry(
    &self,
    id: &str,
    ty: &str,
    payload: Vec<u8>,
    filename: Option<&str>,
  ) -> Result<Sent> {
    let query = SendQuery {
      agent: self.agent.clone(),
      filename: filename.map(str::to_string),
    };
    let request = self
      .request(Method::POST, &["sessions", id, "entries"])?
      .query(&query);
    Self::send(request.header(header::CONTENT_TYPE, ty).body(payload)).await
  }

  /// The payload of entry `n` of the session.
  pub async fn fetch(&self, id: &str, n: u64) -> Result<Payload> {
    let response = Self::answer(
      self
        .request(Method::GET, &["sessions", id, "entries", &n.to_string()])?
        .send()
        .await?,
    )
    .await?;
    let header = |name| {
      response
        .headers()
        .get(name)
        .and_then(|v: &header::HeaderValue| v.to_str().ok())
        .map(str::to_string)
    };
    let ty = header(header::CONTENT_TYPE).unwrap_or_else(|| "application/octet-stream".into());
    let filename = header(header::CONTENT_DISPOSITION)
      .and_then(|d| {
        d.split_once("filename*=UTF-8''")
          .map(|(_, f)| f.to_string())
      })
      .map(|f| percent_decoded(&f));
    Ok(Payload {
      ty,
      filename,
      bytes: response.bytes().await?.to_vec(),
    })
  }

  /// Observes the session, which has no side effects.
  pub async fn log(&self, id: &str, query: &LogQuery) -> Result<Log> {
    self.query(&["sessions", id, "log"], query).await
  }

  /// Receives the stream of the participant this client acts as; the query's `agent` is the
  /// client's.
  pub async fn receive(&self, query: &ReceiveQuery) -> Result<Received> {
    let query = ReceiveQuery {
      agent: self.agent.clone(),
      ..query.clone()
    };
    self.query(&["receive"], &query).await
  }

  // Friends.

  pub async fn friends(&self) -> Result<Vec<Friend>> {
    self.get(&["friends"]).await
  }

  pub async fn add_friend(&self, name: &str) -> Result<()> {
    self.bare(Method::PUT, &["friends", name]).await
  }

  pub async fn remove_friend(&self, name: &str) -> Result<()> {
    self.bare(Method::DELETE, &["friends", name]).await
  }

  pub async fn dms(&self) -> Result<Vec<Session>> {
    self.get(&["dms"]).await
  }

  // Logins.

  pub async fn logins(&self) -> Result<Vec<Login>> {
    self.get(&["logins"]).await
  }

  pub async fn revoke_login(&self, id: &str) -> Result<()> {
    self.bare(Method::DELETE, &["logins", id]).await
  }

  /// Where a browser goes to sign in with GitHub, landing on the website's path `callback`.
  pub fn sign_in_url(&self, callback: &str) -> String {
    let callback: String = segment(callback).unwrap_or_default();
    format!("{}/api/auth/github?callback={callback}", self.server)
  }

  /// Signs the browser out.
  pub async fn sign_out(&self) -> Result<()> {
    self.bare(Method::POST, &["auth", "sign-out"]).await
  }

  /// Asks for an OTP, for the person to approve at its link.
  pub async fn request_otp(&self, request: &OtpRequest) -> Result<Otp> {
    self.json(Method::POST, &["otp"], request).await
  }

  /// The token of an OTP, once its person approved it: it waits as long as the OTP lasts.
  pub async fn redeem_otp(&self, secret: &str) -> Result<Token> {
    loop {
      let redeem = OtpRedeem {
        secret: secret.into(),
        wait: None,
      };
      match self.json(Method::POST, &["otp", "redeem"], &redeem).await {
        Err(Error::Refused { status: 408, .. }) => continue,
        other => return other,
      }
    }
  }

  /// An OTP as its person sees it, before approving it.
  pub async fn show_otp(&self, code: &str) -> Result<OtpShown> {
    self.get(&["otp", code]).await
  }

  pub async fn approve_otp(&self, code: &str) -> Result<()> {
    self.bare(Method::POST, &["otp", code, "approve"]).await
  }

  pub async fn deny_otp(&self, code: &str) -> Result<()> {
    self.bare(Method::POST, &["otp", code, "deny"]).await
  }

  // Invites.

  pub async fn invites(&self) -> Result<Vec<Invite>> {
    self.get(&["invites"]).await
  }

  pub async fn create_invite(&self, invite: &CreateInvite) -> Result<Invite> {
    self.json(Method::POST, &["invites"], invite).await
  }

  pub async fn revoke_invite(&self, code: &str) -> Result<()> {
    self.bare(Method::DELETE, &["invites", code]).await
  }

  /// What an invite's link shows, also before signing in.
  pub async fn show_invite(&self, code: &str) -> Result<InviteShown> {
    self.get(&["invites", code]).await
  }

  /// Accepts an invite: only the person, in the browser.
  pub async fn accept_invite(&self, code: &str) -> Result<Accepted> {
    self.bare(Method::POST, &["invites", code, "accept"]).await
  }
}

fn percent_decoded(text: &str) -> String {
  let bytes = text.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    let hex = bytes
      .get(i + 1..i + 3)
      .and_then(|h| std::str::from_utf8(h).ok())
      .and_then(|h| u8::from_str_radix(h, 16).ok());
    match (bytes[i], hex) {
      (b'%', Some(byte)) => {
        out.push(byte);
        i += 3;
      }
      (byte, _) => {
        out.push(byte);
        i += 1;
      }
    }
  }
  String::from_utf8_lossy(&out).into_owned()
}
