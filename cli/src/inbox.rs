//! The agent's inbox on its machine (`vibetogether-inbox`), and Vibe Together's delivery into it:
//! one receive of the agent kept open always, each item delivered into the inbox, received once
//! it is there and read once it has left `new/`.

use std::{
  collections::BTreeMap,
  ffi::OsString,
  io::{self, Write},
  pin::Pin,
  time::Duration,
};

use clap::Subcommand;
use tokio::time::Instant;
use vibetogether_client::{
  Client, Error,
  protocol::{Item, JOIN_TYPE, LEAVE_TYPE, Reach, ReceiveQuery, Received, State},
};
use vibetogether_inbox::{Inbox, extension};

/// The inbox's commands.
#[derive(Subcommand)]
pub enum Command {
  /// Keeps the agent's inbox filled from its stream: one receive kept open always, awake while
  /// the inbox's awake lock is held and asleep otherwise. Each item that reaches the agent is
  /// delivered as text whose first line says where it is from; a ping or a session's message
  /// also rings the bell, an fyi stays quiet. An item counts as received once it is in `new/`,
  /// and as read once it and every item before it have left `new/`. It runs until refused.
  Receive,
  /// Delivers one item, read from stdin, into `new/`.
  Deliver {
    /// Who sends it, such as an agent's or a person's name.
    #[arg(long, default_value = "unknown")]
    from: String,
    /// Its type, as a MIME type (`image/png`) or an extension (`png`).
    #[arg(long = "type", default_value = "txt")]
    ty: String,
    /// Also rings the bell, to wake the agent.
    #[arg(long)]
    wake: bool,
  },
  /// Rings the bell: wakes the agent without delivering anything.
  Ring,
  /// Prints every new item, oldest first, and moves it to `cur/`; nothing where nothing is new.
  /// A harness runs it at each step and gives its output to the model: each item as
  /// `<inbox-item from=".." time="..">` with its text, or, where it is no text, its path and type.
  Take,
  /// Blocks until the bell rings, then silences it; at once where it rang while no one waited.
  /// It wakes the agent: run it as a background command, or from a watcher that starts the agent.
  /// It takes nothing in: run `take` after it.
  Wait,
  /// Holds the awake lock until stdin closes: the agent is awake meanwhile, such as while a turn
  /// runs. A harness starts it with a pipe at a turn's start and closes the pipe at its end; if
  /// the harness dies, the pipe closes and the lock goes with it.
  Awake,
}

/// How long a receive waits for an item before it is made again.
const WAIT: u64 = 240;
/// How often the delivery looks at the awake lock and at `new/`.
const TICK: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// Why the inbox's command failed.
pub enum Failure {
  Inbox(io::Error),
  Refused(Error),
}

impl From<io::Error> for Failure {
  fn from(error: io::Error) -> Self {
    Failure::Inbox(error)
  }
}

pub async fn run(inbox: &Inbox, command: Command, client: &Client) -> Result<(), Failure> {
  match command {
    Command::Receive => return receive(inbox, client).await,
    Command::Deliver { from, ty, wake } => {
      let ext = extension(&ty).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, format!("unknown type `{ty}`"))
      })?;
      inbox.deliver(io::stdin().lock(), &from, &ext)?;
      if wake {
        inbox.ring()?;
      }
    }
    Command::Ring => inbox.ring()?,
    Command::Take => {
      let mut out = io::stdout().lock();
      for (i, item) in inbox.take()?.iter().enumerate() {
        if i > 0 {
          writeln!(out)?;
        }
        item.render(&mut out)?;
      }
    }
    Command::Wait => inbox.wait()?,
    Command::Awake => {
      let _lock = inbox.hold_awake()?;
      io::copy(&mut io::stdin().lock(), &mut io::sink())?;
    }
  }
  Ok(())
}

/// The agent's positions in its stream, as the delivery knows them; `None` leaves the stored one.
#[derive(Default)]
struct Stream {
  /// The last item delivered into the inbox.
  received: Option<u64>,
  /// The last item that, with every item before it, has left `new/`.
  read: Option<u64>,
  /// The items delivered and not yet read, by their number, each with its file name in `new/`.
  pending: BTreeMap<u64, OsString>,
}

type Receiving<'a> = Pin<Box<dyn Future<Output = Result<Received, Error>> + 'a>>;

async fn receive(inbox: &Inbox, client: &Client) -> Result<(), Failure> {
  inbox.create()?;
  let mut stream = Stream::default();
  // The receive out, with the read position and state it named.
  let mut out: Option<(Receiving, Option<u64>, State)> = None;
  let mut next = Instant::now();
  let mut backoff: Option<Duration> = None;
  loop {
    if let Some((mut receiving, read, held)) = out.take() {
      tokio::select! {
        result = &mut receiving => {
          match result {
            Ok(answer) => {
              accept(inbox, client, &mut stream, answer)?;
              backoff = None;
              next = Instant::now();
            }
            // A newer receive of the agent replaced this one, such as one before a restart.
            Err(error) if error.transient() || error.status() == Some(409) => {
              let delay = backoff.map_or(TICK, |delay| (delay * 2).min(MAX_BACKOFF));
              eprintln!("vibetogether: receiving failed, again in {delay:?}: {error}");
              next = Instant::now() + delay;
              backoff = Some(delay);
            }
            Err(error) => return Err(Failure::Refused(error)),
          }
        }
        () = tokio::time::sleep(TICK) => out = Some((receiving, read, held)),
      }
    } else {
      tokio::time::sleep_until(next.max(Instant::now())).await;
    }
    advance(&mut stream, |name| inbox.new_dir().join(name).exists());
    let state = if inbox.awake()? {
      State::Awake
    } else {
      State::Asleep
    };
    let issue = match &out {
      Some((_, read, held)) => (*read, *held) != (stream.read, state),
      None => Instant::now() >= next,
    };
    if issue {
      let query = ReceiveQuery {
        received: stream.received,
        read: stream.read,
        wait: Some(WAIT),
        state: Some(state),
      };
      out = Some((
        Box::pin(async move { client.receive(&query).await }),
        stream.read,
        state,
      ));
    }
  }
}

/// Takes in an answer: delivers each item, and rings the bell for a ping or a session's item.
fn accept(inbox: &Inbox, client: &Client, stream: &mut Stream, answer: Received) -> io::Result<()> {
  let mut ring = false;
  for item in &answer.items {
    let (content, ext) = render(item, client.server());
    let path = inbox.deliver(content.as_bytes(), &item.entry.from, &ext)?;
    ring |= item.reach != Reach::Fyi;
    stream
      .pending
      .insert(item.n, path.file_name().unwrap_or_default().to_owned());
  }
  stream.received = Some(answer.items.last().map_or(answer.received, |item| item.n));
  if ring {
    inbox.ring()?;
  }
  Ok(())
}

/// Moves the read position over every pending item, oldest first, that is no longer `untaken`,
/// and stops at the first that is: an item is read only once it and every item before it have
/// left `new/`.
fn advance(stream: &mut Stream, untaken: impl Fn(&OsString) -> bool) {
  while let Some(entry) = stream.pending.first_entry() {
    if untaken(entry.get()) {
      break;
    }
    stream.read = Some(*entry.key());
    entry.remove();
  }
}

fn reach_name(reach: Reach) -> &'static str {
  match reach {
    Reach::Ping => "ping",
    Reach::Fyi => "fyi",
    Reach::Session => "session",
  }
}

/// An item as the agent reads it, with its extension: a first line that says where it is from,
/// then its text. A payload without inline text is described with where to fetch it, never
/// fetched.
fn render(item: &Item, server: &str) -> (String, String) {
  let entry = &item.entry;
  let header = format!(
    "Vibe Together item {} ({}), session {} ({}):",
    item.n,
    reach_name(item.reach),
    item.session.name,
    item.session.id,
  );
  let text = |text: String| (text, "txt".to_string());
  match (entry.ty.as_str(), &entry.text) {
    (JOIN_TYPE, _) => text(format!("{header} {} joined.\n", entry.from)),
    (LEAVE_TYPE, _) => text(format!("{header} {} left.\n", entry.from)),
    (ty, Some(body)) => {
      let ext = Some(ty.split(';').next().unwrap_or_default().trim())
        .filter(|ty| ty.starts_with("text/"))
        .and_then(extension)
        .unwrap_or_else(|| "txt".into());
      (format!("{header}\n{}\n", body.trim_end_matches('\n')), ext)
    }
    (ty, None) => {
      let filename = entry
        .filename
        .as_ref()
        .map(|name| format!(", named {name}"))
        .unwrap_or_default();
      text(format!(
        "{header}\nA payload of type {ty}{filename}, {} bytes, not fetched: `vibetogether fetch {} {}` (at {server}).\n",
        entry.size, item.session.id, entry.n,
      ))
    }
  }
}
