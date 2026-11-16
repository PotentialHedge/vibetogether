//! `doctor`: whether this machine's setup works, end to end, each check with what to do
//! where it fails.

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

/// Runs every check, in order, each only where the ones before it hold.
pub async fn run(client: &Client, source: Source, inbox: Option<&Path>) -> Vec<Check> {
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
      "No receive is running, so nothing reaches the agent and others see it offline: keep `vibetogether receive` running, or `vibetogether inbox receive` where it has an inbox.",
    ),
  });

  if let Some(root) = inbox {
    // Read only: the check makes nothing, where the inbox's own commands would.
    let new = vibetogether_inbox::Inbox::new(root).new_dir();
    checks.push(match std::fs::read_dir(&new) {
      Ok(entries) => {
        let untaken = entries
          .filter_map(Result::ok)
          .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
          .count();
        check(
          "inbox",
          true,
          format!(
            "The inbox {} holds {untaken} item{} not yet taken in.",
            root.display(),
            if untaken == 1 { "" } else { "s" }
          ),
        )
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => check(
        "inbox",
        false,
        format!(
          "There is no inbox at {}: `vibetogether inbox receive` makes it and delivers into it.",
          root.display()
        ),
      ),
      Err(error) => check("inbox", false, format!("{}: {error}", new.display())),
    });
  }
  checks
}
