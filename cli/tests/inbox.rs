//! The agent's inbox through the command line: the awake lock across processes, and Vibe
//! Together's delivery into the inbox.

mod common;

use std::{
  process::Stdio,
  time::{Duration, Instant},
};

use common::*;
use vibetogether_client::Client;
use vibetogether_inbox::Inbox;
use vibetogether_protocol::{LoginKind, Presence};

async fn until(what: &str, check: impl AsyncFn() -> bool) {
  let start = Instant::now();
  while !check().await {
    assert!(start.elapsed() < Duration::from_secs(10), "never {what}");
    tokio::time::sleep(Duration::from_millis(20)).await;
  }
}

/// `inbox awake` holds the lock across processes for as long as its stdin is open, and the
/// system releases it when the pipe closes, also when the holder is killed.
#[tokio::test]
async fn awake_is_held_while_stdin_is_open() {
  let setup = setup().await;
  let inbox = Inbox::new(setup.home.join("inbox"));
  let root = inbox.root.to_string_lossy().to_string();
  assert!(!inbox.awake().unwrap());
  let hold = || {
    command(
      &setup.home,
      &setup.url,
      None,
      &["inbox", "--inbox", &root, "awake"],
    )
    .spawn()
    .unwrap()
  };

  let mut holder = hold();
  until("awake", async || inbox.awake().unwrap()).await;
  drop(holder.stdin.take());
  assert!(holder.wait().await.unwrap().success());
  until("asleep", async || !inbox.awake().unwrap()).await;

  let mut holder = hold();
  until("awake", async || inbox.awake().unwrap()).await;
  holder.kill().await.unwrap();
  until("asleep", async || !inbox.awake().unwrap()).await;
}

/// What reaches the agent lands in its inbox, a ping ringing the bell, and is read once taken;
/// the agent is awake while the inbox's lock is held.
#[tokio::test]
async fn vibe_together_delivers_into_the_inbox() {
  let setup = setup().await;
  let inbox = Inbox::new(setup.home.join("inbox"));
  let root = inbox.root.to_string_lossy().to_string();
  let machine = Client::new(&setup.url, Some(setup.token.clone()));
  let agent = machine.create_agent("scout").await.unwrap().id;
  let scout = machine.clone().acting_as(Some(agent.clone()));
  let general = scout.overview(&Default::default()).await.unwrap().groups[0].sessions[0]
    .id
    .clone();
  scout.join(&general).await.unwrap();
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

  let mut delivery = command(
    &setup.home,
    &setup.url,
    Some(&setup.token),
    &["--agent", &agent, "inbox", "--inbox", &root, "receive"],
  )
  .stdout(Stdio::null())
  .spawn()
  .unwrap();
  let presence = async || person.participants(&general).await.unwrap()["luis/scout"].presence;
  until("asleep", async || presence().await == Presence::Asleep).await;
  let _lock = inbox.hold_awake().unwrap();
  until("awake", async || presence().await == Presence::Awake).await;

  // The person's join reached it first, as said in the session.
  until("the join delivered", async || {
    std::fs::read_dir(inbox.new_dir()).unwrap().count() == 1
  })
  .await;
  let join = inbox.take().unwrap();
  assert!(
    matches!(&join[0].content, vibetogether_inbox::Content::Text(t) if t.ends_with(" luis joined.\n"))
  );
  std::fs::remove_file(inbox.wake_file()).unwrap();
  person
    .send_entry(
      &general,
      "text/plain; ping=\"\"",
      b"Quiet here.".to_vec(),
      None,
    )
    .await
    .unwrap();
  person
    .send_entry(
      &general,
      "text/markdown; ping=\"luis/scout\"",
      b"**Scout?**".to_vec(),
      None,
    )
    .await
    .unwrap();
  until("rung", async || inbox.wake_file().exists()).await;
  until("both delivered", async || {
    std::fs::read_dir(inbox.new_dir()).unwrap().count() == 2
  })
  .await;
  let received = async || person.participants(&general).await.unwrap()["luis/scout"].clone();
  let sent = person
    .log(&general, &Default::default())
    .await
    .unwrap()
    .entries
    .last()
    .unwrap()
    .n;
  until("received", async || received().await.received == sent).await;
  assert!(received().await.read < sent);

  let items = inbox.take().unwrap();
  let texts: Vec<_> = items
    .iter()
    .map(|i| match &i.content {
      vibetogether_inbox::Content::Text(text) => text.clone(),
      _ => panic!("not text"),
    })
    .collect();
  assert!(
    texts[0].starts_with("Vibe Together item ")
      && texts[0].contains("(session) from luis, session general (")
  );
  assert!(texts[0].ends_with("\nQuiet here.\n"));
  assert!(texts[1].contains("(ping)") && texts[1].ends_with("\n**Scout?**\n"));
  assert!(items[1].path.extension().is_some_and(|e| e == "md"));
  assert_eq!(items[1].sender.as_deref(), Some("luis"));
  until("read", async || received().await.read == sent).await;
  delivery.kill().await.unwrap();
}
