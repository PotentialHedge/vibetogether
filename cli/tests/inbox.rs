//! Vibe Together's delivery into the agent's inbox, through the command line.

mod common;

use std::{
  process::Stdio,
  time::{Duration, Instant},
};

use common::*;
use mindio::{Content, MindIo};
use vibetogether_client::Client;
use vibetogether_protocol::{LoginKind, Presence};

async fn until(what: &str, check: impl AsyncFn() -> bool) {
  let start = Instant::now();
  while !check().await {
    assert!(start.elapsed() < Duration::from_secs(10), "never {what}");
    tokio::time::sleep(Duration::from_millis(20)).await;
  }
}

/// What reaches the agent lands in its inbox, waking it as its waking rules say, such as only as
/// Vibe Together's notify settings do, and is read once taken; the agent is awake while its lock
/// is held.
#[tokio::test]
async fn vibe_together_delivers_into_the_inbox() {
  let setup = setup().await;
  let io = MindIo::new(setup.home.join("scout"));
  io.create().unwrap();
  std::fs::write(io.waking_file(), "notified=no quiet\n").unwrap();
  let inbox = io.inbox();
  let root = io.root.to_string_lossy().to_string();
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
    &["--agent", &agent, "inbox", "--mindio", &root],
  )
  .stdout(Stdio::null())
  .spawn()
  .unwrap();
  let presence = async || person.participants(&general).await.unwrap()["luis/scout"].presence;
  until("asleep", async || presence().await == Presence::Asleep).await;
  let _lock = io.hold_awake().unwrap();
  until("awake", async || presence().await == Presence::Awake).await;

  // The person's join reached it first, as said in the session.
  until("the join delivered", async || {
    std::fs::read_dir(inbox.new_dir()).unwrap().count() == 1
  })
  .await;
  let join = inbox.take().unwrap();
  assert!(matches!(&join[0].content, Content::Text(t) if t.ends_with("\n\"luis\" joined.\n")));
  // A join is not notified, so the rule leaves it quiet.
  assert!(!io.wake_file().exists());
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
  until("woken", async || io.wake_file().exists()).await;
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
      Content::Text(text) => text.clone(),
      _ => panic!("not text"),
    })
    .collect();
  assert!(
    texts[0].starts_with("Vibe Together item ")
      && texts[0].contains("(session) from \"luis\", session \"general\" (")
      && texts[0].contains("\nSaid by the participant named above, through Vibe Together")
  );
  assert!(texts[0].ends_with("\nQuiet here.\n"));
  assert!(texts[1].contains("(ping)") && texts[1].ends_with("\n**Scout?**\n"));
  assert!(items[1].path.extension().is_some_and(|e| e == "md"));
  assert_eq!(items[1].sender.as_deref(), Some("luis"));
  until("read", async || received().await.read == sent).await;
  delivery.kill().await.unwrap();
}

/// Without an agent named, one delivery serves every agent's IO on the machine that names its
/// agent, as they come and go, and tells an agent the server refuses in its own inbox.
#[tokio::test]
async fn one_delivery_serves_every_agent_on_the_machine() {
  let setup = setup().await;
  let dir = setup.home.join(".agents/mindio");
  let machine = Client::new(&setup.url, Some(setup.token.clone()));
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
  let general = person.overview(&Default::default()).await.unwrap().groups[0].sessions[0]
    .id
    .clone();
  person.join(&general).await.unwrap();
  let io_of = |name: &str, agent: &str| {
    let io = MindIo::new(dir.join(name));
    io.create().unwrap();
    std::fs::write(io.root.join("vibetogether"), format!("{agent}\n")).unwrap();
    io
  };
  let scout = machine.create_agent("scout").await.unwrap().id;
  let scout_io = io_of("claude-code-1", &scout);
  let gone = machine.create_agent("gone").await.unwrap().id;
  machine
    .clone()
    .acting_as(Some(gone.clone()))
    .delete_agent(&gone)
    .await
    .unwrap();
  let gone_io = io_of("claude-code-2", &gone);
  // An agent that names no identity is none of the delivery's.
  MindIo::new(dir.join("pi-3")).create().unwrap();

  let mut delivery = command(&setup.home, &setup.url, Some(&setup.token), &["inbox"])
    .stdout(Stdio::null())
    .spawn()
    .unwrap();
  let presence = async |name: &str| {
    person
      .overview(&Default::default())
      .await
      .unwrap()
      .agents
      .into_iter()
      .find(|a| a.name == format!("luis/{name}"))
      .map(|a| a.presence)
  };
  until("scout asleep", async || {
    presence("scout").await == Some(Presence::Asleep)
  })
  .await;
  until("gone told", async || {
    gone_io.inbox().oldest_untaken().unwrap().is_some()
  })
  .await;
  assert!(
    std::fs::read_dir(dir.join("pi-3/inbox/new"))
      .unwrap()
      .next()
      .is_none()
  );

  person
    .send_entry(
      &general,
      "text/markdown",
      b"@luis/scout here?".to_vec(),
      None,
    )
    .await
    .unwrap();
  until("scout woken", async || scout_io.wake_file().exists()).await;

  // A new agent is served as it comes.
  let pi = machine.create_agent("pi").await.unwrap().id;
  let pi_io = io_of("pi-4", &pi);
  until("pi asleep", async || {
    presence("pi").await == Some(Presence::Asleep)
  })
  .await;
  person
    .send_entry(
      &general,
      "text/markdown",
      b"@luis/pi you too".to_vec(),
      None,
    )
    .await
    .unwrap();
  until("pi woken", async || pi_io.wake_file().exists()).await;
  delivery.kill().await.unwrap();
}

/// One delivery receives from every server an agent has an identity on, each with its own token,
/// and names a session on another server than the base by its host; a command goes to the server
/// its id names, as the identity there.
#[tokio::test]
async fn one_delivery_serves_every_server() {
  let public = setup().await;
  let private = setup().await;
  let host = private.url.trim_start_matches("http://").to_string();
  let dir = public.home.join(".agents/mindio");
  let io = MindIo::new(dir.join("claude-code-1"));
  io.create().unwrap();
  let inbox = io.inbox();
  std::fs::write(
    io.root.join("vibetogether"),
    format!("{}\n{}@{host}\n", public.agent, private.agent),
  )
  .unwrap();
  let person = |s: &Setup| {
    let s = (s.url.clone(), s.app.clone(), s.account.clone());
    async move {
      Client::new(
        &s.0,
        Some(
          s.1
            .new_login(&s.2, LoginKind::Person, "phone")
            .await
            .unwrap(),
        ),
      )
    }
  };
  let (on_public, on_private) = (person(&public).await, person(&private).await);
  let general = async |c: &Client| {
    let id = c.overview(&Default::default()).await.unwrap().groups[0].sessions[0]
      .id
      .clone();
    c.join(&id).await.unwrap();
    id
  };
  let (public_general, private_general) = (general(&on_public).await, general(&on_private).await);
  let tokens = format!(
    "{}\n{}\n{}\n{}\n",
    public.token, public.url, private.token, private.url
  );
  let mut delivery = command(&public.home, &public.url, None, &["inbox"])
    .env("VIBETOGETHER_TOKEN", &tokens)
    .stdout(Stdio::null())
    .spawn()
    .unwrap();
  let asleep = async |c: &Client| {
    c.overview(&Default::default())
      .await
      .unwrap()
      .agents
      .iter()
      .any(|a| a.presence == Presence::Asleep)
  };
  until("asleep on both", async || {
    asleep(&on_public).await && asleep(&on_private).await
  })
  .await;
  for (c, general) in [
    (&on_public, &public_general),
    (&on_private, &private_general),
  ] {
    c.send_entry(general, "text/markdown", b"@luis/laptop hi".to_vec(), None)
      .await
      .unwrap();
  }
  let said = std::cell::RefCell::new(Vec::new());
  until("both delivered", async || {
    said.borrow_mut().extend(
      inbox
        .take()
        .unwrap()
        .into_iter()
        .filter_map(|i| match i.content {
          Content::Text(text) if text.contains("hi") => Some(text),
          _ => None,
        }),
    );
    said.borrow().len() >= 2
  })
  .await;
  let said = said.into_inner().join("\n");
  assert!(said.contains(&format!("({public_general}):")), "{said}");
  assert!(
    said.contains(&format!("({private_general}@{host}):")),
    "{said}"
  );
  delivery.kill().await.unwrap();

  // The private session's address leads the command there, as the private identity.
  let joined = command(
    &public.home,
    &public.url,
    None,
    &["join", &format!("{private_general}@{host}")],
  )
  .env("VIBETOGETHER_TOKEN", &tokens)
  .env("MINDIO", &io.root)
  .output()
  .await
  .unwrap();
  assert!(
    joined.status.success(),
    "{}",
    String::from_utf8_lossy(&joined.stderr)
  );
  let sent = command(
    &public.home,
    &public.url,
    None,
    &["send", &format!("{private_general}@{host}")],
  )
  .env("VIBETOGETHER_TOKEN", &tokens)
  .env("MINDIO", &io.root)
  .spawn()
  .unwrap();
  let output = {
    let mut sent = sent;
    use tokio::io::AsyncWriteExt;
    let mut stdin = sent.stdin.take().unwrap();
    stdin.write_all(b"back").await.unwrap();
    drop(stdin);
    sent.wait_with_output().await.unwrap()
  };
  assert!(
    output.status.success(),
    "{}",
    String::from_utf8_lossy(&output.stderr)
  );
  let log = on_private
    .log(&private_general, &Default::default())
    .await
    .unwrap();
  assert_eq!(log.entries.last().unwrap().from, "luis/laptop");
}
