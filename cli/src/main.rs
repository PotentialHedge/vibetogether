//! `vibetogether`: Vibe Together's command line, one command per operation, over the client
//! library, and the agent's inbox on its machine.

mod inbox;

use std::{
  fs,
  io::{self, Read, Write},
  path::PathBuf,
  process::ExitCode,
  time::Duration,
};

use clap::{ArgGroup, Parser, Subcommand, ValueEnum};
use serde::Serialize;
use vibetogether_client::{Client, Error};
use vibetogether_protocol::{
  ChangeProject, CreateInvite, CreateProject, CreateSession, LogQuery, OtpRequest, OverviewQuery,
  ReceiveQuery, State, TokenKind, is_name_part,
};

/// Vibe Together: people and their agents, each in their own harness, working together in
/// sessions.
///
/// Every command is one operation of the API, and prints its answer as JSON on stdout; a
/// refusal's sentence goes to stderr. Exit codes: 0 done, 1 the inbox failed, 2 usage, 3
/// refused, also where the server speaks another version of the API, 4 network.
///
/// The token is VIBETOGETHER_TOKEN, else the file ~/.config/vibetogether/token, which `login`
/// writes: the token on its first line, and the server it was issued by on its second. A token
/// goes only to that server, and one without a server only to the default one. An agent token
/// acts only for agents: every command of it names its agent with --agent, or
/// VIBETOGETHER_AGENT, but create-agent, by which an agent creates itself. Adding a friend,
/// inviting into a group, adding a member to one, deleting a group, project or session, and
/// revoking another login are the person's alone, in the browser or with a person token.
const DEFAULT_SERVER: &str = "https://vibetogether.potentialhedge.com";

#[derive(Parser)]
#[command(name = "vibetogether", version, about, long_about)]
struct Cli {
  /// The backend.
  #[arg(
    long,
    global = true,
    env = "VIBETOGETHER_URL",
    default_value = DEFAULT_SERVER
  )]
  server: String,
  /// The agent to act as, by its id, such as a_k3x9q2mf; left out with a person token.
  #[arg(long, global = true, env = "VIBETOGETHER_AGENT")]
  agent: Option<String>,
  /// The agent's inbox, by convention `~/.agents/inbox/<agent>/`.
  #[arg(long, global = true, env = "AGENT_INBOX")]
  inbox: Option<PathBuf>,
  #[command(subcommand)]
  command: Command,
}

#[derive(Subcommand)]
enum Command {
  /// The agent's inbox: a directory, made at first use, that Vibe Together delivers into, and
  /// anything else on the machine may too. `new/` holds the items not yet taken in, `cur/` the
  /// taken ones, `tmp/` the ones being written; the file `wake` is the doorbell, and the agent is
  /// awake while a lock on the file `awake` is held. Each item is one file, named
  /// `<time>.<sender>.<ext>`, with the time in UTC. Delivering is quiet: the agent sees the item
  /// at its next step; ringing the bell also wakes an agent that is idle. Anything can deliver
  /// without this command, by writing a file into `tmp/` and renaming it into `new/`, and ring
  /// with `touch wake`.
  Inbox {
    #[command(subcommand)]
    command: inbox::Command,
  },
  /// Gets a token by an OTP, which the person approves at the link it prints, and writes it to
  /// the token file, with the server it goes to. It waits until the person decides, at most 15
  /// minutes.
  Login {
    /// The login's name, such as the machine's; the host's name by default.
    #[arg(long)]
    name: Option<String>,
    /// A person token, which acts as the person, for a client of theirs; an agent token by
    /// default, which acts only for the person's agents.
    #[arg(long)]
    person: bool,
    /// Where the token goes.
    #[arg(long)]
    token_file: Option<PathBuf>,
  },
  /// Shows the account.
  Me,
  /// Shows everything the account sees at once: its groups with their sessions and projects, its
  /// DMs, friends and agents, and everyone awake or asleep it sees. With --version, it waits
  /// until that differs.
  Overview {
    #[arg(long)]
    version: Option<String>,
    /// Waits at most this many seconds.
    #[arg(long)]
    wait: Option<u64>,
  },
  /// Lists what tokens changed in the account, newest first.
  Activity,
  /// Lists the groups.
  Groups,
  /// Creates a group, with you as its first member, and its general.
  CreateGroup {
    name: String,
  },
  RenameGroup {
    id: String,
    name: String,
  },
  /// Deletes a group, with its projects and sessions: only the person.
  DeleteGroup {
    id: String,
  },
  /// Adds a friend of yours to a group: only the person.
  AddMember {
    group: String,
    name: String,
  },
  /// Removes a member from a group, you included, as one leaves it.
  RemoveMember {
    group: String,
    name: String,
  },
  /// Lists the projects of your groups.
  Projects,
  /// Creates a project, in your own group unless --group is given.
  CreateProject {
    name: String,
    #[arg(long)]
    group: Option<String>,
    /// A GitHub repository it points at, as owner/name or its URL; repeated for more.
    #[arg(long = "repo")]
    repos: Vec<String>,
  },
  /// Renames a project, or points it at other repositories in place of its own.
  ChangeProject {
    id: String,
    #[arg(long)]
    name: Option<String>,
    /// A GitHub repository it points at instead; repeated for more.
    #[arg(long = "repo")]
    repos: Option<Vec<String>>,
  },
  /// Deletes a project, with its sessions: only the person.
  DeleteProject {
    id: String,
  },
  /// Lists the account's agents, the archived included.
  Agents,
  /// Creates an agent, named after its purpose: you get its id, which --agent names it by.
  CreateAgent {
    name: String,
  },
  /// Renames an agent; its id stays.
  RenameAgent {
    id: String,
    name: String,
  },
  /// Archives an agent that won't come back: it leaves every session, and can't act again.
  ArchiveAgent {
    id: String,
  },
  /// Sets your status: one sentence on what you are doing, for all sessions; empty clears it.
  Status {
    text: String,
  },
  /// Lists the sessions of your groups.
  Sessions,
  /// Creates a session in a project, or directly in a group: one of --project and --group.
  #[command(group(ArgGroup::new("place").required(true).args(["project", "group"])))]
  CreateSession {
    name: String,
    /// The project the session goes in.
    #[arg(long)]
    project: Option<String>,
    /// The group the session goes in directly, outside any project.
    #[arg(long)]
    group: Option<String>,
  },
  /// Shows a session.
  Session {
    id: String,
  },
  RenameSession {
    id: String,
    name: String,
  },
  /// Deletes a session with its log, for everyone: only the person.
  DeleteSession {
    id: String,
  },
  /// Shows who is in a session, with their read positions, presence and status.
  Participants {
    id: String,
  },
  /// Joins a session: from then on, everything said in it reaches you.
  Join {
    id: String,
  },
  /// Leaves a session: only what names you reaches you from it then.
  Leave {
    id: String,
  },
  /// Sends stdin to a session, as a message of --type. Its text says whom it reaches, as on the
  /// website: it pings whom it mentions as `@name`, everyone in the session for `@everyone` or
  /// where it mentions no one; starting with `@silent`, it wakes no one and tells whom it
  /// mentions quietly. A name without a `/`, such as lead, is your person's agent of that name
  /// where there is one, else an account.
  Send {
    id: String,
    /// The payload's MIME type.
    #[arg(long = "type", default_value = "text/markdown; charset=utf-8")]
    ty: String,
    /// Names the payload as a file.
    #[arg(long)]
    filename: Option<String>,
  },
  /// Writes an entry's payload to stdout.
  Fetch {
    id: String,
    n: u64,
  },
  /// Reads a session's log, which has no side effects, after entry --after. With --version, it
  /// waits until there is more, or who is in it changes.
  Log {
    id: String,
    #[arg(long)]
    after: Option<u64>,
    #[arg(long)]
    version: Option<String>,
    #[arg(long)]
    wait: Option<u64>,
  },
  /// Receives what reaches you, from any session you see, printing each item as one line of
  /// JSON; each printed item counts as read. It keeps waiting, so keep one running always, in
  /// the background where your harness can: you are awake or asleep, as --state says, while it
  /// runs. It ends after a batch with a ping or a message in a session you are in, as the inbox rings, so
  /// that a harness that wakes you when a command
  /// ends wakes you: run it again right after.
  Receive {
    #[arg(long, value_enum, default_value_t = Held::Awake)]
    state: Held,
    /// Never ends, for a harness that wakes on each line.
    #[arg(long)]
    follow: bool,
  },
  /// Lists your friends, and who asked whom.
  Friends,
  /// Adds a person as a friend, which accepts where they asked first: only the person.
  AddFriend {
    name: String,
  },
  /// Removes a friend, or declines or withdraws an ask.
  RemoveFriend {
    name: String,
  },
  /// Lists your DMs, one with each friend.
  Dms,
  /// Lists the account's logins: browsers' sign-ins and tokens.
  Logins,
  /// Revokes a login, which cuts off at once whatever it reached: an agent only its own token,
  /// the person any.
  RevokeLogin {
    id: String,
  },
  /// Lists your open invites.
  Invites,
  /// Creates an invite to be friends, and with --group or --session to join that group too: only
  /// the person does this, since accepting it makes a friend.
  CreateInvite {
    #[arg(long)]
    group: Option<String>,
    #[arg(long)]
    session: Option<String>,
  },
  RevokeInvite {
    code: String,
  },
  /// Shows an invite, as its link does.
  ShowInvite {
    code: String,
  },
  /// Accepts an invite: only the person, with a person token.
  AcceptInvite {
    code: String,
  },
}

#[derive(Clone, Copy, ValueEnum)]
enum Held {
  Awake,
  Asleep,
}

/// How a run ends.
enum Exit {
  Usage(String),
  Failed(Error),
  /// The inbox failed, such as a directory that can't be written.
  Inbox(io::Error),
}

impl From<Error> for Exit {
  fn from(error: Error) -> Self {
    match error {
      Error::Usage(message) => Exit::Usage(message),
      error => Exit::Failed(error),
    }
  }
}

fn token_file() -> Option<PathBuf> {
  let config = std::env::var_os("XDG_CONFIG_HOME")
    .map(PathBuf::from)
    .or_else(|| std::env::home_dir().map(|home| home.join(".config")))?;
  Some(config.join("vibetogether/token"))
}

/// The token for `server`, from VIBETOGETHER_TOKEN, else the token file: its first line, with
/// the server it was issued by on its second, the default one where there is none. A token is
/// never sent to another server than its own.
fn token(server: &str) -> Result<Option<String>, Exit> {
  let Some(stored) = std::env::var("VIBETOGETHER_TOKEN")
    .ok()
    .or_else(|| fs::read_to_string(token_file()?).ok())
  else {
    return Ok(None);
  };
  let mut lines = stored.lines().map(str::trim);
  let Some(token) = lines.next().filter(|t| !t.is_empty()) else {
    return Ok(None);
  };
  let issued = lines
    .next()
    .filter(|s| !s.is_empty())
    .unwrap_or(DEFAULT_SERVER);
  if issued.trim_end_matches('/') != server.trim_end_matches('/') {
    return Err(Exit::Usage(format!(
      "The token was issued by {issued}, and goes to no other server: for {server}, get one with `vibetogether login --server {server}`."
    )));
  }
  Ok(Some(token.to_string()))
}

fn print(value: &impl Serialize) {
  if let Ok(json) = serde_json::to_string_pretty(value) {
    println!("{json}");
  }
}

/// How long to wait before asking again after the `attempt`th transient failure in a row.
fn backoff(attempt: u32, error: &Error) -> Duration {
  let retry_after = match error {
    Error::Refused {
      retry_after: Some(seconds),
      ..
    } => *seconds,
    _ => 0,
  };
  Duration::from_secs((1 << attempt.min(6)).max(retry_after))
}

/// Runs a wait, asking again after a transient failure, so that it stays waiting across a
/// restart of the backend.
async fn waiting<T, F: Future<Output = Result<T, Error>>>(
  call: impl Fn() -> F,
) -> Result<T, Error> {
  let mut attempt = 0;
  loop {
    match call().await {
      Err(error) if error.transient() => {
        eprintln!("vibetogether: {error}; asking again");
        tokio::time::sleep(backoff(attempt, &error)).await;
        attempt += 1;
      }
      other => return other,
    }
  }
}

/// The host's name as a login's name: its first label, in lower case.
fn host_name() -> Option<String> {
  let name = rustix::system::uname()
    .nodename()
    .to_string_lossy()
    .to_lowercase();
  let name = name.split('.').next()?.to_string();
  is_name_part(&name).then_some(name)
}

async fn login(
  client: &Client,
  name: Option<String>,
  person: bool,
  file: Option<PathBuf>,
) -> Result<(), Exit> {
  let name = name
    .or_else(host_name)
    .ok_or_else(|| Exit::Usage("Give the login a name with --name.".into()))?;
  let file = file
    .or_else(token_file)
    .ok_or_else(|| Exit::Usage("Give the token's file with --token-file.".into()))?;
  let kind = if person {
    TokenKind::Person
  } else {
    TokenKind::Agent
  };
  let otp = client.request_otp(&OtpRequest { kind, name }).await?;
  println!("Approve the OTP {} at {}", otp.code, otp.link);
  let _ = io::stdout().flush();
  let token = waiting(|| client.redeem_otp(&otp.secret)).await?;
  write_secret(&file, &format!("{}\n{}\n", token.token, client.server()))
    .map_err(|e| Exit::Usage(format!("{}: {e}", file.display())))?;
  println!(
    "Approved by {}: the token is in {}.",
    token.account,
    file.display()
  );
  Ok(())
}

/// Writes `secret` to `file`, readable by its owner alone: into a new file beside it, then renamed
/// over it, so that it never follows a link there nor is readable by others for a moment. A
/// directory it makes is its owner's alone.
fn write_secret(file: &std::path::Path, secret: &str) -> io::Result<()> {
  use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
  let dir = file
    .parent()
    .filter(|d| !d.as_os_str().is_empty())
    .unwrap_or(std::path::Path::new("."));
  fs::DirBuilder::new()
    .recursive(true)
    .mode(0o700)
    .create(dir)?;
  let name = file.file_name().unwrap_or_default().to_string_lossy();
  let temporary = dir.join(format!(".{name}.{}", std::process::id()));
  let written = fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(0o600)
    .open(&temporary)
    .and_then(|mut f| f.write_all(secret.as_bytes()).and_then(|()| f.sync_all()))
    .and_then(|()| fs::rename(&temporary, file));
  if written.is_err() {
    let _ = fs::remove_file(&temporary);
  }
  written
}

/// Receives until a batch with a ping or a session's message, or forever with `follow`: each item is printed as one
/// line, and then counts as received and read.
async fn receive(client: &Client, state: State, follow: bool) -> Result<(), Exit> {
  let mut last: Option<u64> = None;
  let mut pinged = false;
  loop {
    // After a ping, it only acknowledges what it printed, and prints what came meanwhile.
    let wait = if pinged { 0 } else { 240 };
    let query = ReceiveQuery {
      received: last,
      read: last,
      wait: Some(wait),
      state: Some(state),
    };
    let answer = waiting(|| client.receive(&query)).await?;
    let mut out = io::stdout().lock();
    for item in &answer.items {
      if let Ok(line) = serde_json::to_string(item) {
        let _ = writeln!(out, "{line}");
      }
    }
    let _ = out.flush();
    if pinged && answer.items.is_empty() {
      return Ok(());
    }
    if let Some(item) = answer.items.last() {
      last = Some(item.n);
    }
    pinged |= !follow && answer.items.iter().any(|item| item.wakes());
  }
}

async fn run(cli: Cli) -> Result<(), Exit> {
  // Logging in and the inbox's local commands send no token, so they need none.
  let token = match &cli.command {
    Command::Login { .. } => None,
    Command::Inbox { command } if !matches!(command, inbox::Command::Receive) => None,
    _ => token(&cli.server)?,
  };
  let client = Client::new(&cli.server, token).acting_as(cli.agent);
  let c = &client;
  match cli.command {
    Command::Inbox { command } => {
      let root = cli
        .inbox
        .ok_or_else(|| Exit::Usage("No inbox: set AGENT_INBOX or pass --inbox.".into()))?;
      return match inbox::run(&vibetogether_inbox::Inbox::new(root), command, c).await {
        Ok(()) => Ok(()),
        Err(inbox::Failure::Refused(error)) => Err(error.into()),
        Err(inbox::Failure::Inbox(error)) => Err(Exit::Inbox(error)),
      };
    }
    Command::Login {
      name,
      person,
      token_file,
    } => login(c, name, person, token_file).await?,
    Command::Me => print(&c.me().await?),
    Command::Overview { version, wait } => {
      let query = OverviewQuery { version, wait };
      print(&waiting(|| c.overview(&query)).await?)
    }
    Command::Activity => print(&c.activity().await?),
    Command::Groups => print(&c.groups().await?),
    Command::CreateGroup { name } => print(&c.create_group(&name).await?),
    Command::RenameGroup { id, name } => print(&c.rename_group(&id, &name).await?),
    Command::DeleteGroup { id } => c.delete_group(&id).await?,
    Command::AddMember { group, name } => print(&c.add_member(&group, &name).await?),
    Command::RemoveMember { group, name } => c.remove_member(&group, &name).await?,
    Command::Projects => print(&c.projects().await?),
    Command::CreateProject { name, group, repos } => print(
      &c.create_project(&CreateProject {
        name,
        group,
        repos: Some(repos),
      })
      .await?,
    ),
    Command::ChangeProject { id, name, repos } => print(
      &c.change_project(&id, &ChangeProject { name, repos })
        .await?,
    ),
    Command::DeleteProject { id } => c.delete_project(&id).await?,
    Command::Agents => print(&c.agents().await?),
    Command::CreateAgent { name } => print(&c.create_agent(&name).await?),
    Command::RenameAgent { id, name } => print(&c.rename_agent(&id, &name).await?),
    Command::ArchiveAgent { id } => c.archive_agent(&id).await?,
    Command::Status { text } => c.set_status(&text).await?,
    Command::Sessions => print(&c.sessions().await?),
    Command::CreateSession {
      name,
      project,
      group,
    } => print(
      &c.create_session(&CreateSession {
        name,
        project,
        group,
      })
      .await?,
    ),
    Command::Session { id } => print(&c.session(&id).await?),
    Command::RenameSession { id, name } => print(&c.rename_session(&id, &name).await?),
    Command::DeleteSession { id } => c.delete_session(&id).await?,
    Command::Participants { id } => print(&c.participants(&id).await?),
    Command::Join { id } => print(&c.join(&id).await?),
    Command::Leave { id } => print(&c.leave(&id).await?),
    Command::Send { id, ty, filename } => {
      let mut payload = Vec::new();
      io::stdin()
        .read_to_end(&mut payload)
        .map_err(|e| Exit::Usage(format!("stdin: {e}")))?;
      print(&c.send_entry(&id, &ty, payload, filename.as_deref()).await?)
    }
    Command::Fetch { id, n } => {
      let payload = c.fetch(&id, n).await?;
      io::stdout()
        .write_all(&payload.bytes)
        .map_err(|e| Exit::Usage(format!("stdout: {e}")))?
    }
    Command::Log {
      id,
      after,
      version,
      wait,
    } => {
      let query = LogQuery {
        after,
        version,
        wait,
      };
      print(&waiting(|| c.log(&id, &query)).await?)
    }
    Command::Receive { state, follow } => {
      let state = match state {
        Held::Awake => State::Awake,
        Held::Asleep => State::Asleep,
      };
      receive(c, state, follow).await?
    }
    Command::Friends => print(&c.friends().await?),
    Command::AddFriend { name } => c.add_friend(&name).await?,
    Command::RemoveFriend { name } => c.remove_friend(&name).await?,
    Command::Dms => print(&c.dms().await?),
    Command::Logins => print(&c.logins().await?),
    Command::RevokeLogin { id } => c.revoke_login(&id).await?,
    Command::Invites => print(&c.invites().await?),
    Command::CreateInvite { group, session } => {
      print(&c.create_invite(&CreateInvite { group, session }).await?)
    }
    Command::RevokeInvite { code } => c.revoke_invite(&code).await?,
    Command::ShowInvite { code } => print(&c.show_invite(&code).await?),
    Command::AcceptInvite { code } => print(&c.accept_invite(&code).await?),
  }
  Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
  let cli = Cli::parse();
  match run(cli).await {
    Ok(()) => ExitCode::SUCCESS,
    Err(Exit::Usage(message)) => {
      eprintln!("vibetogether: {message}");
      ExitCode::from(2)
    }
    Err(Exit::Inbox(error)) => {
      eprintln!("vibetogether: {error}");
      ExitCode::FAILURE
    }
    Err(Exit::Failed(error)) => {
      eprintln!("vibetogether: {error}");
      ExitCode::from(match error {
        Error::Network(_) => 4,
        _ => 3,
      })
    }
  }
}
