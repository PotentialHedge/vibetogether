//! A backend on loopback, with people signed in to it, as the tests call it: through the client
//! library, as every client does.

#![allow(dead_code)]

use std::{
  path::PathBuf,
  sync::atomic::{AtomicI64, Ordering},
  time::Duration,
};

use reqwest::header::{COOKIE, HeaderMap, HeaderValue, ORIGIN};
use sqlx::{Connection, SqliteConnection};
use vibetogether_backend::{App, Config};
use vibetogether_client::{Client, Error};
use vibetogether_protocol::{Item, LoginKind, Reach, ReceiveQuery};

pub struct Server {
  pub url: String,
  pub app: App,
  pub database: PathBuf,
}

/// A fresh directory of its own, under the system's temporary one.
pub fn scratch() -> PathBuf {
  static N: AtomicI64 = AtomicI64::new(0);
  let dir = std::env::temp_dir().join(format!(
    "vibetogether-test-{}-{}",
    std::process::id(),
    N.fetch_add(1, Ordering::Relaxed)
  ));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

/// A backend on its own database, at a free port of loopback.
pub async fn server() -> Server {
  server_on(scratch().join("backend.db")).await
}

pub async fn server_on(database: PathBuf) -> Server {
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let url = format!("http://{}", listener.local_addr().unwrap());
  let config = Config {
    url: url.clone(),
    database: database.clone(),
    github_client_id: "test".into(),
    github_client_secret: "test".into(),
  };
  let app = App::new(config).await.unwrap();
  let router = app.router();
  tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
  Server { url, app, database }
}

/// A person signed in: their browser, by its cookie, which is the person; an agent token of
/// theirs, acting as their agent `laptop`; and a person token.
#[derive(Clone)]
pub struct Person {
  pub id: String,
  pub login: String,
  pub browser: Client,
  pub machine: Client,
  pub own: Client,
}

impl Server {
  pub async fn person(&self, login: &str) -> Person {
    static GITHUB: AtomicI64 = AtomicI64::new(1000);
    let id = self
      .app
      .sign_up(GITHUB.fetch_add(1, Ordering::Relaxed), login, login, None)
      .await
      .unwrap();
    let cookie = self
      .app
      .new_login(&id, LoginKind::Browser, "a sign-in")
      .await
      .unwrap();
    let machine = self
      .token(&id, LoginKind::Agent, &format!("{login}-laptop"))
      .await;
    let laptop = machine.create_agent("laptop").await.unwrap();
    let machine = machine.acting_as(Some(laptop.id));
    let own = self
      .token(&id, LoginKind::Person, &format!("{login}-phone"))
      .await;
    Person {
      id,
      login: login.into(),
      browser: self.browser(&cookie),
      machine,
      own,
    }
  }

  /// A client with a new token of the account.
  pub async fn token(&self, account: &str, kind: LoginKind, name: &str) -> Client {
    let token = self.app.new_login(account, kind, name).await.unwrap();
    Client::new(&self.url, Some(token))
  }

  /// A client as a browser of the site: with the sign-in's cookie, from the site's origin.
  pub fn browser(&self, cookie: &str) -> Client {
    self.browser_from(cookie, &self.url)
  }

  pub fn browser_from(&self, cookie: &str, origin: &str) -> Client {
    let mut headers = HeaderMap::new();
    let cookie = format!("vibetogether.session_token={cookie}");
    headers.insert(COOKIE, HeaderValue::from_str(&cookie).unwrap());
    headers.insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
    let http = reqwest::Client::builder()
      .default_headers(headers)
      .build()
      .unwrap();
    Client::with_http(http, &self.url, None)
  }

  /// A connection of its own to the backend's database, for what no request reaches.
  pub async fn db(&self) -> SqliteConnection {
    SqliteConnection::connect(&format!("sqlite:{}", self.database.display()))
      .await
      .unwrap()
  }
}

/// The status a call answered with: 200 for any success.
pub fn status<T>(result: Result<T, Error>) -> u16 {
  match result {
    Ok(_) => 200,
    Err(Error::Refused { status, .. }) => status,
    Err(e) => panic!("not refused, but {e}"),
  }
}

/// Each item as its sender, its text or else its type, and its reach.
pub fn said(items: &[Item]) -> Vec<(String, String, Reach)> {
  items
    .iter()
    .map(|i| {
      (
        i.entry.from.clone(),
        i.entry.text.clone().unwrap_or(i.entry.ty.clone()),
        i.reach,
      )
    })
    .collect()
}

pub fn s(text: &str) -> String {
  text.to_string()
}

pub fn query(received: Option<u64>, read: Option<u64>, wait: Option<u64>) -> ReceiveQuery {
  ReceiveQuery {
    received,
    read,
    wait,
    state: None,
  }
}

/// Receives and reads everything that reached the participant so far.
pub async fn caught_up(client: &Client) {
  let answer = client
    .receive(&query(Some(1_000_000), Some(1_000_000), Some(0)))
    .await
    .unwrap();
  assert!(answer.items.is_empty());
}

/// What reached the participant since, at once.
pub async fn now(client: &Client) -> Vec<Item> {
  client
    .receive(&query(None, None, Some(0)))
    .await
    .unwrap()
    .items
}

pub async fn sleep(ms: u64) {
  tokio::time::sleep(Duration::from_millis(ms)).await
}
