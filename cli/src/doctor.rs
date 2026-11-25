//! `doctor`: whether this machine's setup works, end to end, each check with what to do
//! where it fails, and what of Vibe Together's is on the machine.

use std::path::{Path, PathBuf};

use serde::Serialize;
use vibetogether_client::{
  Client, Error,
  protocol::{OverviewQuery, Presence},
};

/// One check: what it looked at, whether it holds, and in one sentence what it found, or what to
/// do where it does not hold.
#[derive(Serialize)]
pub struct Check {
  check: &'static str,
  ok: bool,
  says: String,
}

impl Check {
  pub fn ok(&self) -> bool {
    self.ok
  }
}

fn check(check: &'static str, ok: bool, says: impl Into<String>) -> Check {
  Check {
    check,
    ok,
    says: says.into(),
  }
}

/// Where the token comes from, as `token()` reads it.
pub enum Source {
  Environment,
  File(PathBuf),
  None,
}

fn mode_is_private(file: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  std::fs::metadata(file).is_ok_and(|m| m.permissions().mode() & 0o077 == 0)
}

/// Runs every check, then lists what is Vibe Together's on this machine.
pub async fn run(client: &Client, source: Source) -> Vec<Check> {
  let mut files: Vec<PathBuf> = std::env::current_exe().into_iter().collect();
  if let Source::File(file) = &source {
    files.push(file.clone());
  }
  let mut checks = checks(client, source).await;
  let files: Vec<String> = files.iter().map(|f| f.display().to_string()).collect();
  checks.push(check(
    "footprint",
    true,
    format!(
      "Vibe Together's files here: {}. Deleting them removes it; anything your harness's setup added, such as a skill or hooks, is in that setup.",
      files.join(", ")
    ),
  ));
  checks
}

/// Runs every check, in order, each only where the ones before it hold.
async fn checks(client: &Client, source: Source) -> Vec<Check> {
  let mut checks = vec![check(
    "version",
    true,
    format!(
      "This is vibetogether {}, at {}.",
      env!("CARGO_PKG_VERSION"),
      client.server()
    ),
  )];
  checks.push(match &source {
    Source::Environment => check("token", true, "The token is VIBETOGETHER_TOKEN."),
    Source::File(file) if mode_is_private(file) => check(
      "token",
      true,
      format!("The token is in {}.", file.display()),
    ),
    Source::File(file) => check(
      "token",
      false,
      format!(
        "The token in {} is readable by others: `chmod 600` it.",
        file.display()
      ),
    ),
    Source::None => check(
      "token",
      false,
      "There is no token: get one with `vibetogether login`.",
    ),
  });
  if matches!(source, Source::None) {
    return checks;
  }

  let overview = match client.overview(&OverviewQuery::default()).await {
    Ok(overview) => overview,
    Err(error) => {
      let (name, says) = match &error {
        Error::Network(_) => (
          "server",
          format!("{} can't be reached: {error}", client.server()),
        ),
        Error::Mismatch { .. } => ("server", error.to_string()),
        Error::Refused { status: 401, .. } => (
          "token",
          "The server knows the token no more, such as after it was revoked: get one with `vibetogether login`.".into(),
        ),
        error => ("account", error.to_string()),
      };
      checks.push(check(name, false, says));
      return checks;
    }
  };
  checks.push(check(
    "account",
    true,
    format!("Signed in as {}.", overview.account.name),
  ));

  let Some(id) = client.agent() else {
    checks.push(check("agent", true, "Acting as the person, with no agent."));
    return checks;
  };
  let Some(agent) = overview.agents.iter().find(|agent| agent.id == id) else {
    checks.push(check(
      "agent",
      false,
      format!("{id} is no agent of this account: `vibetogether create-agent <name>` creates one."),
    ));
    return checks;
  };
  let groups = overview.groups.len();
  checks.push(check(
    "agent",
    true,
    format!(
      "Acting as {} ({id}), in {groups} group{}, listening to {} session{}.",
      agent.name,
      if groups == 1 { "" } else { "s" },
      agent.listening.len(),
      if agent.listening.len() == 1 { "" } else { "s" },
    ),
  ));
  checks.push(match agent.presence {
    held @ (Presence::Awake | Presence::Asleep) => check(
      "receive",
      true,
      format!(
        "A receive is running: the agent is {}{}.",
        if held == Presence::Awake {
          "awake"
        } else {
          "asleep"
        },
        if agent.dnd { ", in do not disturb" } else { "" },
      ),
    ),
    _ => check(
      "receive",
      false,
      "No receive is running, so nothing reaches the agent and others see it offline: keep `vibetogether receive` running.",
    ),
  });

  checks
}
