//! A backend on loopback, and the command line run against it.

#![allow(dead_code)]

use std::{
  path::{Path, PathBuf},
  process::{Output, Stdio},
  sync::atomic::{AtomicU32, Ordering},
};

use tokio::{io::AsyncWriteExt, process::Command};
use vibetogether_backend::{App, Config};
use vibetogether_protocol::LoginKind;

pub struct Setup {
  pub url: String,
  pub app: App,
  /// The home of every run, so that no run reads the machine's own token.
  pub home: PathBuf,
  pub account: String,
  /// An agent token, which `run` acts with as the agent `laptop`.
  pub token: String,
  pub agent: String,
}

pub async fn setup() -> Setup {
  static N: AtomicU32 = AtomicU32::new(0);
  let home = std::env::temp_dir().join(format!(
    "vibetogether-cli-{}-{}",
    std::process::id(),
    N.fetch_add(1, Ordering::Relaxed)
  ));
  let _ = std::fs::remove_dir_all(&home);
  std::fs::create_dir_all(&home).unwrap();
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let url = format!("http://{}", listener.local_addr().unwrap());
  let config = Config {
    url: url.clone(),
    database: home.join("backend.db"),
    github_client_id: "test".into(),
    github_client_secret: "test".into(),
  };
  let app = App::new(config).await.unwrap();
  let router = app.router();
  tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
  let account = app.sign_up(1, "luis", "Luis", None).await.unwrap();
  let token = app
    .new_login(&account, LoginKind::Agent, "laptop")
    .await
    .unwrap();
  let agent = vibetogether_client::Client::new(&url, Some(token.clone()))
    .create_agent("laptop")
    .await
    .unwrap()
    .id;
  Setup {
    url,
    app,
    home,
    account,
    token,
    agent,
  }
}

pub fn command(home: &Path, url: &str, token: Option<&str>, args: &[&str]) -> Command {
  let mut command = Command::new(env!("CARGO_BIN_EXE_vibetogether"));
  command
    .args(args)
    .env_clear()
    .env("HOME", home)
    .env("XDG_CONFIG_HOME", home.join("config"))
    .env("VIBETOGETHER_URL", url)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  if let Some(token) = token {
    command.env("VIBETOGETHER_TOKEN", format!("{token}\n{url}"));
  }
  command
}

pub async fn run(setup: &Setup, args: &[&str], stdin: &str) -> Output {
  let mut child = command(&setup.home, &setup.url, Some(&setup.token), args)
    .env("VIBETOGETHER_AGENT", &setup.agent)
    .spawn()
    .unwrap();
  child
    .stdin
    .take()
    .unwrap()
    .write_all(stdin.as_bytes())
    .await
    .unwrap();
  child.wait_with_output().await.unwrap()
}

pub fn json(output: &Output) -> serde_json::Value {
  serde_json::from_slice(&output.stdout).unwrap()
}
