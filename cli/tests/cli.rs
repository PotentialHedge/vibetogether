//! The command line against a backend on loopback: its answers and its exit codes.

mod common;

use common::*;
use reqwest::header::{COOKIE, HeaderMap, HeaderValue, ORIGIN};
use tokio::io::{AsyncBufReadExt, BufReader};
use vibetogether_client::Client;
use vibetogether_protocol::{Item, LoginKind, Reach};

#[tokio::test]
async fn exit_codes_say_what_went_wrong() {
  let setup = setup().await;
  assert_eq!(run(&setup, &["--help"], "").await.status.code(), Some(0));
  assert_eq!(
    run(&setup, &["no-such-command"], "").await.status.code(),
    Some(2)
  );
  assert_eq!(run(&setup, &["send"], "").await.status.code(), Some(2));
  // A session goes in a project or a group, and the error names both.
  let placeless = run(&setup, &["create-session", "x"], "").await;
  assert_eq!(placeless.status.code(), Some(2));
  let stderr = String::from_utf8_lossy(&placeless.stderr);
  assert!(stderr.contains("--project") && stderr.contains("--group"));
  assert_eq!(
    run(&setup, &["session", ".."], "").await.status.code(),
    Some(2)
  );
  // Renaming and deleting tell what an id names by its prefix.
  let unknown = run(&setup, &["rename", "x_1", "y"], "").await;
  assert_eq!(unknown.status.code(), Some(2));
  assert!(String::from_utf8_lossy(&unknown.stderr).contains("s_"));
  assert_eq!(
    run(&setup, &["delete", "x_1"], "").await.status.code(),
    Some(2)
  );
  // Refused: no token, and no agent named with an agent token.
  let anonymous = command(&setup.home, &setup.url, None, &["overview"])
    .output()
    .await
    .unwrap();
  assert_eq!(anonymous.status.code(), Some(3));
  assert!(String::from_utf8_lossy(&anonymous.stderr).contains("Sign in"));
  let unnamed = command(&setup.home, &setup.url, Some(&setup.token), &["overview"])
    .output()
    .await
    .unwrap();
  assert_eq!(unnamed.status.code(), Some(3));
  // The network: nothing listens there.
  let closed = command(
    &setup.home,
    "http://127.0.0.1:9",
    Some(&setup.token),
    &["overview"],
  )
  .output()
  .await
  .unwrap();
  assert_eq!(closed.status.code(), Some(4));
  let me = run(&setup, &["overview"], "").await;
  assert_eq!(me.status.code(), Some(0));
  assert_eq!(json(&me)["account"]["name"], "luis");
}

#[tokio::test]
async fn a_token_goes_out_only_encrypted() {
  let setup = setup().await;
  let refused = command(
    &setup.home,
    "http://vibetogether.example",
    Some(&setup.token),
    &["overview"],
  )
  .output()
  .await
  .unwrap();
  assert_eq!(refused.status.code(), Some(2));
  assert!(String::from_utf8_lossy(&refused.stderr).contains("is no server"));
  // A trailing slash is the same server.
  let slash = command(
    &setup.home,
    &format!("{}/", setup.url),
    Some(&setup.token),
    &["overview"],
  )
  .env("VIBETOGETHER_AGENT", &setup.agent)
  .output()
  .await
  .unwrap();
  assert_eq!(slash.status.code(), Some(0));
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
    &["--agent", &agent, "send", &general],
    "@luis Hi, `$you`.",
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
  assert_eq!(said["text"], "@luis Hi, `$you`.");
  assert_eq!(said["type"], "text/markdown; charset=utf-8; ping=\"luis\"");

  // A session shows with who is in it, and renames by its id, as an agent does.
  let shown = json(&run(&setup, &["session", &general], "").await);
  assert_eq!(shown["name"], "general");
  assert!(shown["participants"]["luis/scout"].is_object());
  assert_eq!(
    run(
      &setup,
      &["--agent", &agent, "rename", &agent, "scout-2"],
      ""
    )
    .await
    .status
    .code(),
    Some(0)
  );
  let overview = json(&run(&setup, &["overview"], "").await);
  assert_eq!(overview["agents"][0]["name"], "luis/scout-2");
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
  headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
  let browser = Client::with_http(
    reqwest::Client::builder()
      .default_headers(headers)
      .build()
      .unwrap(),
    &setup.url,
    None,
  );
  // A link where the token goes is replaced, never followed.
  let file = setup.home.join("config/vibetogether/token");
  let elsewhere = setup.home.join("elsewhere");
  std::fs::create_dir_all(file.parent().unwrap()).unwrap();
  std::os::unix::fs::symlink(&elsewhere, &file).unwrap();
  assert_eq!(browser.show_otp(&code).await.unwrap().name, "test-box");
  browser.approve_otp(&code).await.unwrap();
  // It names who approved it.
  let approved = lines.next_line().await.unwrap().unwrap();
  assert!(approved.starts_with("Approved by luis:"), "{approved}");
  assert_eq!(login.wait().await.unwrap().code(), Some(0));
  use std::os::unix::fs::PermissionsExt;
  assert!(!elsewhere.exists());
  assert!(!std::fs::symlink_metadata(&file).unwrap().is_symlink());
  assert_eq!(
    std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
    0o600
  );
  // The file holds the token alone.
  let stored = std::fs::read_to_string(&file).unwrap();
  assert!(
    stored.starts_with("vt_") && stored.lines().count() == 1,
    "{stored}"
  );
  let created = command(&setup.home, &setup.url, None, &["create-agent", "box"])
    .output()
    .await
    .unwrap();
  assert_eq!(created.status.code(), Some(0));
  assert!(
    browser
      .logins()
      .await
      .unwrap()
      .iter()
      .any(|l| l.name == "test-box" && l.kind == LoginKind::Agent)
  );
}

#[tokio::test]
async fn doctor_says_what_fails() {
  let setup = setup().await;
  let failing = |output: &std::process::Output| -> Vec<String> {
    json(output)
      .as_array()
      .unwrap()
      .iter()
      .filter(|c| c["ok"] == false)
      .map(|c| c["check"].as_str().unwrap().to_string())
      .collect()
  };
  // No token: it stops there.
  let none = command(&setup.home, &setup.url, None, &["doctor"])
    .output()
    .await
    .unwrap();
  assert_eq!(none.status.code(), Some(5));
  assert_eq!(failing(&none), ["token"]);
  // An agent with nothing receiving for it.
  let quiet = run(&setup, &["doctor"], "").await;
  assert_eq!(quiet.status.code(), Some(5));
  assert_eq!(failing(&quiet), ["receive"]);
  // With a receive held, it all holds.
  let mut receive = command(
    &setup.home,
    &setup.url,
    Some(&setup.token),
    &["receive", "--follow", "--agent", &setup.agent],
  )
  .spawn()
  .unwrap();
  let mut held = None;
  for _ in 0..50 {
    let output = run(&setup, &["doctor"], "").await;
    if output.status.code() == Some(0) {
      held = Some(output);
      break;
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
  }
  receive.kill().await.unwrap();
  assert!(failing(&held.expect("the receive shows")).is_empty());
}

#[tokio::test]
async fn an_agent_deletes_into_the_trash_and_restores() {
  let setup = setup().await;
  let scout = json(&run(&setup, &["create-agent", "scout"], "").await)["id"]
    .as_str()
    .unwrap()
    .to_string();
  let deleted = run(&setup, &["delete", &scout], "").await;
  assert_eq!(deleted.status.code(), Some(0));
  let trash = json(&run(&setup, &["trash"], "").await);
  assert_eq!(trash[0]["id"], scout.as_str());
  assert_eq!(trash[0]["kind"], "agent");
  let restored = run(&setup, &["restore", &scout], "").await;
  assert_eq!(restored.status.code(), Some(0));
  assert_eq!(
    json(&run(&setup, &["trash"], "").await),
    serde_json::json!([])
  );
}
