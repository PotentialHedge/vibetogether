//! The command line against a backend on loopback: its answers and its exit codes.

use std::{
  path::{Path, PathBuf},
  process::{Output, Stdio},
  sync::atomic::{AtomicU32, Ordering},
};

use reqwest::header::{COOKIE, HeaderMap, HeaderValue, ORIGIN};
use tokio::{
  io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
  process::Command,
};
use vibetogether_backend::{App, Config};
use vibetogether_client::Client;
use vibetogether_protocol::{Item, LoginKind, Reach};

struct Setup {
  url: String,
  app: App,
  /// The home of every run, so that no run reads the machine's own token.
  home: PathBuf,
  account: String,
  token: String,
}

async fn setup() -> Setup {
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
  Setup {
    url,
    app,
    home,
    account,
    token,
  }
}

fn command(home: &Path, url: &str, token: Option<&str>, args: &[&str]) -> Command {
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
    command.env("VIBETOGETHER_TOKEN", token);
  }
  command
}

async fn run(setup: &Setup, args: &[&str], stdin: &str) -> Output {
  let mut child = command(&setup.home, &setup.url, Some(&setup.token), args)
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

fn json(output: &Output) -> serde_json::Value {
  serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn exit_codes_say_what_went_wrong() {
  let setup = setup().await;
  assert_eq!(run(&setup, &["--help"], "").await.status.code(), Some(0));
  assert_eq!(
    run(&setup, &["no-such-command"], "").await.status.code(),
    Some(2)
  );
  assert_eq!(run(&setup, &["send"], "").await.status.code(), Some(2));
  assert_eq!(
    run(&setup, &["session", ".."], "").await.status.code(),
    Some(2)
  );
  // Refused: no token, and no agent named with an agent token.
  let anonymous = command(&setup.home, &setup.url, None, &["me"])
    .output()
    .await
    .unwrap();
  assert_eq!(anonymous.status.code(), Some(3));
  assert!(String::from_utf8_lossy(&anonymous.stderr).contains("Sign in"));
  assert_eq!(
    run(&setup, &["status", "busy"], "").await.status.code(),
    Some(3)
  );
  // The network: nothing listens there.
  let closed = command(
    &setup.home,
    "http://127.0.0.1:9",
    Some(&setup.token),
    &["me"],
  )
  .output()
  .await
  .unwrap();
  assert_eq!(closed.status.code(), Some(4));
  let me = run(&setup, &["me"], "").await;
  assert_eq!(me.status.code(), Some(0));
  assert_eq!(json(&me)["name"], "luis");
}

#[tokio::test]
async fn an_agent_sends_and_receives() {
  let setup = setup().await;
  let agent = json(&run(&setup, &["create-agent", "scout"], "").await)["id"]
    .as_str()
    .unwrap()
    .to_string();
  let overview = json(&run(&setup, &["overview"], "").await);
  let general = overview["groups"][0]["sessions"][0]["id"]
    .as_str()
    .unwrap()
    .to_string();
  assert_eq!(
    run(&setup, &["--agent", &agent, "join", &general], "")
      .await
      .status
      .code(),
    Some(0)
  );

  // Its receive prints each item as a line, and ends after a batch with a ping.
  let mut receive = command(
    &setup.home,
    &setup.url,
    Some(&setup.token),
    &["receive", "--agent", &agent],
  )
  .spawn()
  .unwrap();
  let mut lines = BufReader::new(receive.stdout.take().unwrap()).lines();
  let person = Client::new(
    &setup.url,
    Some(
      setup
        .app
        .new_login(&setup.account, LoginKind::Person, "phone")
        .await
        .unwrap(),
    ),
  );
  person.join(&general).await.unwrap();
  let joined: Item = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
  assert_eq!(
    (joined.entry.from.as_str(), joined.reach),
    ("luis", Reach::Session)
  );
  let sent = run(
    &setup,
    &["--agent", &agent, "send", &general, "--ping", "luis"],
    "Hi, `$you`.",
  )
  .await;
  assert_eq!(sent.status.code(), Some(0));
  person
    .send_entry(
      &general,
      "text/plain; ping=\"luis/scout\"",
      b"Hey scout.".to_vec(),
      None,
    )
    .await
    .unwrap();
  let pinged: Item = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
  assert_eq!(
    (pinged.entry.text.as_deref(), pinged.reach),
    (Some("Hey scout."), Reach::Ping)
  );
  assert_eq!(receive.wait().await.unwrap().code(), Some(0));
  // What it printed counts as read.
  let shown = person.participants(&general).await.unwrap();
  assert_eq!(shown["luis/scout"].read, pinged.entry.n);

  let log = json(&run(&setup, &["log", &general], "").await);
  let said = log["entries"]
    .as_array()
    .unwrap()
    .iter()
    .find(|e| e["from"] == "luis/scout" && !e["text"].is_null())
    .unwrap()
    .clone();
  assert_eq!(said["text"], "Hi, `$you`.");
  assert_eq!(said["type"], "text/markdown; charset=utf-8; ping=\"luis\"");
}

#[tokio::test]
async fn login_writes_the_token_its_person_approves() {
  let setup = setup().await;
  let mut login = command(
    &setup.home,
    &setup.url,
    None,
    &["login", "--name", "test-box"],
  )
  .spawn()
  .unwrap();
  let mut lines = BufReader::new(login.stdout.take().unwrap()).lines();
  let line = lines.next_line().await.unwrap().unwrap();
  let code = line.split_whitespace().nth(3).unwrap().to_string();
  let cookie = setup
    .app
    .new_login(&setup.account, LoginKind::Browser, "a sign-in")
    .await
    .unwrap();
  let mut headers = HeaderMap::new();
  headers.insert(
    COOKIE,
    HeaderValue::from_str(&format!("vibetogether.session_token={cookie}")).unwrap(),
  );
  headers.insert(ORIGIN, HeaderValue::from_str(&setup.url).unwrap());
  let browser = Client::with_http(
    reqwest::Client::builder()
      .default_headers(headers)
      .build()
      .unwrap(),
    &setup.url,
    None,
  );
  assert_eq!(browser.show_otp(&code).await.unwrap().name, "test-box");
  browser.approve_otp(&code).await.unwrap();
  assert_eq!(login.wait().await.unwrap().code(), Some(0));
  let file = setup.home.join("config/vibetogether/token");
  use std::os::unix::fs::PermissionsExt;
  assert_eq!(
    std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
    0o600
  );
  let me = command(&setup.home, &setup.url, None, &["me"])
    .output()
    .await
    .unwrap();
  assert_eq!(me.status.code(), Some(0));
  assert!(
    browser
      .logins()
      .await
      .unwrap()
      .iter()
      .any(|l| l.name == "test-box" && l.kind == LoginKind::Agent)
  );
}
