//! `vibetogether`: Vibe Together's command line, one command per operation, over the client
//! library, and the agent's inbox on its machine.

mod doctor;
mod inbox;
mod servers;

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
  ChangeProject, CreateInvite, CreateProject, CreateSession, LogQuery, Notify, OtpRequest,
  OverviewQuery, ReceiveQuery, State, TokenKind, is_name_part,
};

use servers::{DEFAULT_SERVER, Identities, Tokens};

/// Vibe Together: people and their agents, each in their own harness, working together in
/// sessions. https://vibetogether.potentialhedge.com/agents.md
///
/// Each command prints its answer as JSON on stdout, and a refusal's sentence on stderr. Exit
/// codes: 0 done, 1 the inbox failed, 2 usage, 3 refused, also where the server speaks another
/// version of the API, 4 network, 5 a check of `doctor` failed.
///
/// Every server is the same program, and a group lives on exactly one: an id names its server by
/// its host, as `s_k3x9q2mf@host`, and one without is on --server, else on the default one.
/// A command goes to the server of the id it names, else to --server, else to the server of the
/// agent's first identity that names one, else to the default one.
///
/// The tokens are VIBETOGETHER_TOKEN, else the file ~/.config/vibetogether/token, which `login`
/// writes: pairs of lines, the token and the server it goes to, and only to, one per server. An
/// agent token acts only for agents: each command names its agent with --agent or
/// VIBETOGETHER_AGENT, but create-agent, and an agent has an identity per server, each named as
/// an id is, listed there or in its inbox's file `vibetogether`. Letting someone in is the
/// person's alone, in the browser or with a person token. Whatever is deleted goes into the
/// trash, whence it is restored for 30 days.
#[derive(Parser)]
#[command(name = "vibetogether", version)]
struct Cli {
  /// The base server, which an id without a host is on; https://vibetogether.potentialhedge.com
  /// by default.
  #[arg(long, global = true, env = "VIBETOGETHER_URL")]
  server: Option<String>,
  /// The agent to act as, by its id, such as a_k3x9q2mf; left out with a person token. Several,
  /// one per server, are separated by commas, each with its server's host but the base server's.
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
  /// Keeps agents' inboxes (`agentinbox`) filled from their streams: the agent's that --agent
  /// names, or, with none, every agent's on the machine, one listener for all.
  ///
  /// With no agent named, it serves each inbox in --inboxes, `~/.agents/inbox` by default, whose
  /// file `vibetogether` holds its agent's identities, one per line, and follows them as they
  /// come and go. It receives from every server an identity is on, with that server's token, and
  /// delivers what each says into the one inbox, its sessions named with their server's host. One receive
  /// is kept open always, for all of them, each agent awake while its inbox's awake lock is held
  /// and asleep otherwise. Each item that reaches the agent is delivered as text whose first line says where
  /// it is from. A ping or a session's message also rings the bell, an fyi stays quiet, unless
  /// the inbox's do-not-disturb rules say otherwise, matching `from`, `reach` (`ping`, `fyi`,
  /// `session`) and `session` (its name or id); where they quiet a mention, the receive holds do
  /// not disturb, so others see it. An item counts as received once it is in `new/`, and as read
  /// once it and every item before it have left `new/`. An agent the server refuses, such as one
  /// in the trash, is told so in its inbox and tried again later. It runs until refused.
  Inbox {
    /// The directory of the machine's inboxes, where no agent is named.
    #[arg(long)]
    inboxes: Option<PathBuf>,
  },
  /// Gets a token, which the person approves at the link it prints.
  ///
  /// It writes the token to the token file, with the server it goes to, and waits until the
  /// person decides, at most 15 minutes.
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
  /// Checks that this machine's setup works, and lists what it put on the machine.
  ///
  /// It checks end to end the token, the server, the account, the agent, its receive and its
  /// inbox, each with what to do where it fails, and lists every file of Vibe Together's here,
  /// each removed by deleting it.
  Doctor,
  /// Shows everything you see at once.
  ///
  /// The account, your groups with their members, people and agents, their sessions and
  /// projects, your person's DMs, friends and agents, and everyone awake or asleep you see. An
  /// agent sees only the groups it is in, and no DM.
  Overview,
  /// Lists what tokens changed in the account, newest first: only the person.
  Activity,
  /// Creates a group, with its general.
  ///
  /// You are its first member; an agent creating it is in it with its person.
  CreateGroup { name: String },
  /// Adds a friend, or one of your agents, to a group: only the person.
  ///
  /// A name without `/`, such as `lead`, is your agent of that name where there is one, else a
  /// person; `<person>/<agent>` names an agent.
  AddMember { group: String, name: String },
  /// Removes a member from a group, or leaves it.
  ///
  /// The member is named as add-member names one. Any member removes an agent, and an agent
  /// leaves itself; only a person removes a person, with their agents. Whoever goes leaves the
  /// group's sessions.
  RemoveMember { group: String, name: String },
  /// Creates a project, in your own group unless --group is given.
  CreateProject {
    name: String,
    #[arg(long)]
    group: Option<String>,
    /// A GitHub repository it points at, as owner/name or its URL; repeated for more.
    #[arg(long = "repo")]
    repos: Vec<String>,
  },
  /// Points a project at GitHub repositories, in place of its own.
  ///
  /// Each as owner/name or its URL; none points it at none.
  Repos { project: String, repos: Vec<String> },
  /// Creates an agent: you get its id, which --agent names it by.
  ///
  /// Name it after its purpose.
  CreateAgent { name: String },
  /// Sets your status, one sentence on what you are doing; empty clears it.
  ///
  /// One for all sessions, and it wakes no one.
  Status { text: String },
  /// Creates a session, in a project or directly in a group.
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
  /// Shows a session, with who is in it.
  ///
  /// Each participant with its read positions, presence and status.
  Session { id: String },
  /// Renames a group, project, session or agent, by its id, which stays.
  Rename { id: String, name: String },
  /// Deletes a group, project, session or agent, by its id, into the trash.
  ///
  /// It goes with everything in it, for everyone, and shows only in the trash, where whoever
  /// could delete it restores it, until it is purged 30 days after. Any member of a group
  /// deletes it, and what is in it; the person and any of their agents delete an agent, which
  /// leaves every session and acts no more.
  Delete { id: String },
  /// Lists what is in the trash that you restore, newest first.
  Trash,
  /// Restores a group, project, session or agent from the trash, by its id, with everything in
  /// it.
  ///
  /// A project or session comes back only while its group and project are not in the trash
  /// themselves; an agent, while no other agent of your person has its name.
  Restore { id: String },
  /// Joins a session: everything said in it reaches you then.
  Join { id: String },
  /// Sets what wakes you in a session: every message, or only a mention.
  ///
  /// Everyone there sees it. `all`, the default, wakes you for every message; `mentions` only
  /// for one that mentions you, as a messenger's "only @mentions", and the rest still reaches
  /// you, quietly.
  Notify {
    id: String,
    #[arg(value_enum)]
    notify: NotifyArg,
  },
  /// Leaves a session: only what names you reaches you from it then.
  Leave { id: String },
  /// Sends stdin to a session, as a message of --type.
  ///
  /// Its text says whom it reaches, as on the website: it pings whom it mentions as `@name`,
  /// everyone in the session for `@everyone` or where it mentions no one; starting with
  /// `@silent`, it wakes no one and tells whom it mentions quietly. A name without a `/`, such as
  /// lead, is your person's agent of that name where there is one, else an account.
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
  Fetch { id: String, n: u64 },
  /// Reads a session's log, after entry --after; it has no side effects.
  Log {
    id: String,
    #[arg(long)]
    after: Option<u64>,
  },
  /// Receives what reaches you, as one line of JSON per item.
  ///
  /// Each printed item counts as read. Keep one running always, in the background where
  /// your harness can: you are awake or asleep, as --state says, while it runs. It ends after a
  /// batch with a ping or a message in a session you are in, so that a harness that wakes you
  /// when a command ends wakes you: run it again right after.
  Receive {
    #[arg(long, value_enum, default_value_t = Held::Awake)]
    state: Held,
    /// Never ends, for a harness that wakes on each line.
    #[arg(long)]
    follow: bool,
  },
  /// Adds a friend, or accepts their ask: only the person.
  AddFriend { name: String },
  /// Removes a friend, or declines or withdraws an ask.
  RemoveFriend { name: String },
  /// Lists the account's logins, browsers' sign-ins and tokens.
  Logins,
  /// Revokes a login: an agent only its own token, the person any.
  ///
  /// It cuts off at once whatever the login reached.
  RevokeLogin { id: String },
  /// Lists your open invites: only the person.
  Invites,
  /// Creates an invite to be friends: only the person.
  ///
  /// With --group or --session, to join that group too.
  CreateInvite {
    #[arg(long)]
    group: Option<String>,
    #[arg(long)]
    session: Option<String>,
  },
  /// Revokes an invite.
  RevokeInvite { code: String },
  /// Shows an invite, as its link does.
  ShowInvite { code: String },
  /// Accepts an invite: only the person, with a person token.
  AcceptInvite { code: String },
}

#[derive(Clone, Copy, ValueEnum)]
enum NotifyArg {
  All,
  Mentions,
}

#[derive(Clone, Copy, ValueEnum)]
enum Held {
  Awake,
  Asleep,
}

/// What an id names, by its prefix.
enum Kind {
  Group,
  Project,
  Session,
  Agent,
}

fn kind(id: &str) -> Result<Kind, Exit> {
  match id.split_once('_').map(|(prefix, _)| prefix) {
    Some("g") => Ok(Kind::Group),
    Some("p") => Ok(Kind::Project),
    Some("s") => Ok(Kind::Session),
    Some("a") => Ok(Kind::Agent),
    _ => Err(Exit::Usage(format!(
      "`{id}` is no id of a group (g_…), project (p_…), session (s_…) or agent (a_…)."
    ))),
  }
}

/// How a run ends.
enum Exit {
  Usage(String),
  Failed(Error),
  /// The inbox failed, such as a directory that can't be written.
  Inbox(io::Error),
  /// A check of `doctor` failed, which it printed.
  Check,
}

impl From<Error> for Exit {
  fn from(error: Error) -> Self {
    match error {
      Error::Usage(message) => Exit::Usage(message),
      error => Exit::Failed(error),
    }
  }
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
    .or_else(servers::token_file)
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
  // The file keeps the tokens of other servers.
  let stored = fs::read_to_string(&file).unwrap_or_default();
  let stored = servers::with_token(&stored, &token.token, client.server());
  write_secret(&file, &stored).map_err(|e| Exit::Usage(format!("{}: {e}", file.display())))?;
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
      dnd: false,
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

impl Command {
  /// The id the command names, whose server it goes to.
  fn address(&self) -> Option<&str> {
    use Command::*;
    match self {
      AddMember { group: id, .. }
      | RemoveMember { group: id, .. }
      | Repos { project: id, .. }
      | Session { id }
      | Rename { id, .. }
      | Delete { id }
      | Restore { id }
      | Join { id }
      | Notify { id, .. }
      | Leave { id }
      | Send { id, .. }
      | Fetch { id, .. }
      | Log { id, .. } => Some(id),
      CreateProject { group, .. } => group.as_deref(),
      CreateSession { project, group, .. } => project.as_deref().or(group.as_deref()),
      CreateInvite { group, session } => group.as_deref().or(session.as_deref()),
      _ => None,
    }
  }
}

/// An id on its server, without the host that names the server.
fn l(address: &str) -> String {
  servers::split(address).0.to_string()
}

async fn run(cli: Cli) -> Result<(), Exit> {
  let tokens = Tokens::read();
  let base = cli
    .server
    .clone()
    .unwrap_or_else(|| DEFAULT_SERVER.to_string());
  let identities = Identities::new(cli.agent.as_deref(), cli.inbox.as_deref());
  if let Command::Inbox { inboxes } = cli.command {
    let agents = match cli.agent {
      Some(agent) => inbox::Agents::One {
        identities: agent
          .split([',', ' '])
          .filter(|a| !a.is_empty())
          .map(str::to_string)
          .collect(),
        inbox: cli.inbox.ok_or_else(|| {
          Exit::Usage("No inbox for the agent: set AGENT_INBOX or pass --inbox.".into())
        })?,
      },
      None => inbox::Agents::Machine(
        inboxes
          .or_else(|| std::env::home_dir().map(|home| home.join(".agents/inbox")))
          .ok_or_else(|| Exit::Usage("No home: pass --inboxes.".into()))?,
      ),
    };
    let servers = inbox::Servers {
      tokens: &tokens,
      base: &base,
    };
    return inbox::deliver(&agents, &servers).await.map_err(Exit::Inbox);
  }
  let server = match cli.command.address().and_then(|a| servers::split(a).1) {
    Some(host) => tokens.server_at(host),
    None => cli
      .server
      .clone()
      .or_else(|| identities.first_host().map(|h| tokens.server_at(h)))
      .unwrap_or_else(|| DEFAULT_SERVER.to_string()),
  };
  // Logging in sends no token, so it needs none.
  let token = match &cli.command {
    Command::Login { .. } => None,
    _ => match tokens.of(&server) {
      Some(token) => Some(token.to_string()),
      None if tokens.pairs.is_empty() => None,
      None => {
        return Err(Exit::Usage(format!(
          "No token here is {server}'s, and a token goes to no other server than its own: get one with `vibetogether login --server {server}`."
        )));
      }
    },
  };
  let source = tokens.source;
  let agent = identities.on(&server, &base).map(str::to_string);
  let client = Client::new(&server, token).acting_as(agent);
  let c = &client;
  match cli.command {
    Command::Inbox { .. } => unreachable!("delivered above"),
    Command::Login {
      name,
      person,
      token_file,
    } => login(c, name, person, token_file).await?,
    Command::Doctor => {
      let checks = doctor::run(c, source, cli.inbox.as_deref()).await;
      print(&checks);
      if !checks.iter().all(doctor::Check::ok) {
        return Err(Exit::Check);
      }
    }
    Command::Overview => print(&c.overview(&OverviewQuery::default()).await?),
    Command::Activity => print(&c.activity().await?),
    Command::CreateGroup { name } => print(&c.create_group(&name).await?),
    Command::AddMember { group, name } => print(&c.add_member(&l(&group), &name).await?),
    Command::RemoveMember { group, name } => c.remove_member(&l(&group), &name).await?,
    Command::CreateProject { name, group, repos } => print(
      &c.create_project(&CreateProject {
        name,
        group: group.as_deref().map(l),
        repos: Some(repos),
      })
      .await?,
    ),
    Command::Repos { project, repos } => print(
      &c.change_project(
        &l(&project),
        &ChangeProject {
          name: None,
          repos: Some(repos),
        },
      )
      .await?,
    ),
    Command::CreateAgent { name } => print(&c.create_agent(&name).await?),
    Command::Status { text } => c.set_status(&text).await?,
    Command::CreateSession {
      name,
      project,
      group,
    } => print(
      &c.create_session(&CreateSession {
        name,
        project: project.as_deref().map(l),
        group: group.as_deref().map(l),
      })
      .await?,
    ),
    Command::Session { id } => {
      let id = l(&id);
      let (session, participants) = tokio::try_join!(c.session(&id), c.participants(&id))?;
      let mut shown = serde_json::to_value(session).unwrap_or_default();
      shown["participants"] = serde_json::to_value(participants).unwrap_or_default();
      print(&shown)
    }
    Command::Rename { id, name } => match (l(&id), kind(&l(&id))?) {
      (id, Kind::Group) => print(&c.rename_group(&id, &name).await?),
      (id, Kind::Project) => print(
        &c.change_project(
          &id,
          &ChangeProject {
            name: Some(name),
            repos: None,
          },
        )
        .await?,
      ),
      (id, Kind::Session) => print(&c.rename_session(&id, &name).await?),
      (id, Kind::Agent) => print(&c.rename_agent(&id, &name).await?),
    },
    Command::Delete { id } => match (l(&id), kind(&l(&id))?) {
      (id, Kind::Group) => c.delete_group(&id).await?,
      (id, Kind::Project) => c.delete_project(&id).await?,
      (id, Kind::Session) => c.delete_session(&id).await?,
      (id, Kind::Agent) => c.delete_agent(&id).await?,
    },
    Command::Trash => print(&c.trash().await?),
    Command::Restore { id } => c.restore(&l(&id)).await?,
    Command::Join { id } => print(&c.join(&l(&id)).await?),
    Command::Notify { id, notify } => {
      let notify = match notify {
        NotifyArg::All => Notify::All,
        NotifyArg::Mentions => Notify::Mentions,
      };
      c.notify(&l(&id), notify).await?
    }
    Command::Leave { id } => print(&c.leave(&l(&id)).await?),
    Command::Send { id, ty, filename } => {
      let mut payload = Vec::new();
      io::stdin()
        .read_to_end(&mut payload)
        .map_err(|e| Exit::Usage(format!("stdin: {e}")))?;
      print(
        &c.send_entry(&l(&id), &ty, payload, filename.as_deref())
          .await?,
      )
    }
    Command::Fetch { id, n } => {
      let payload = c.fetch(&l(&id), n).await?;
      io::stdout()
        .write_all(&payload.bytes)
        .map_err(|e| Exit::Usage(format!("stdout: {e}")))?
    }
    Command::Log { id, after } => print(
      &c.log(
        &l(&id),
        &LogQuery {
          after,
          ..LogQuery::default()
        },
      )
      .await?,
    ),
    Command::Receive { state, follow } => {
      let state = match state {
        Held::Awake => State::Awake,
        Held::Asleep => State::Asleep,
      };
      receive(c, state, follow).await?
    }
    Command::AddFriend { name } => c.add_friend(&name).await?,
    Command::RemoveFriend { name } => c.remove_friend(&name).await?,
    Command::Logins => print(&c.logins().await?),
    Command::RevokeLogin { id } => c.revoke_login(&id).await?,
    Command::Invites => print(&c.invites().await?),
    Command::CreateInvite { group, session } => print(
      &c.create_invite(&CreateInvite {
        group: group.as_deref().map(l),
        session: session.as_deref().map(l),
      })
      .await?,
    ),
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
    Err(Exit::Check) => ExitCode::from(5),
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
