//! The account: the person, everything they see at once, what their agents changed, and their
//! agents, each created once and named by its id.

use std::collections::HashSet;

use axum::{Json, extract::State, http::StatusCode};
use serde_json::{Value, json};
use vibetogether_protocol::{
  Account, Activity, Agent, AgentQuery, GroupOverview, MAX_WAIT, NameBody, Named, Overview,
  OverviewQuery, Presence, ProjectOverview, Reachable, StatusBody, is_name_part,
};

use crate::{
  App,
  caller::Caller,
  changes::version_of,
  db::{self, Db, session_for},
  error::{Refusal, Result, is_taken},
  extract::{Json as Body, Path, Query},
  friends::{dms_of, friends_of},
  groups::{group_json, groups_of, project_json, projects_of},
  sessions::sessions_of,
  transport,
};

/// The most agents an account has that are not archived.
const MAX_AGENTS: i64 = 100;
/// The most agents an account has ever had, so that archiving cannot make room without end.
const MAX_AGENTS_EVER: i64 = 1000;

async fn status_of(db: &mut Db, participant: &str) -> Result<Option<String>> {
  Ok(
    sqlx::query_scalar("SELECT text FROM status WHERE participant = ?")
      .bind(participant)
      .fetch_optional(db)
      .await?,
  )
}

async fn account_json(db: &mut Db, id: &str) -> Result<Account> {
  let (name, display_name, image): (String, String, Option<String>) =
    sqlx::query_as("SELECT login, display_name, image FROM account WHERE id = ?")
      .bind(id)
      .fetch_one(&mut *db)
      .await?;
  Ok(Account {
    id: id.to_string(),
    name,
    display_name,
    image,
    status: status_of(db, id).await?,
  })
}

/// The caller's account.
pub async fn me(State(app): State<App>, caller: Caller) -> Result<Json<Account>> {
  let mut db = app.db.acquire().await?;
  Ok(Json(account_json(&mut db, &caller.account).await?))
}

/// The participants awake or asleep that `me` sees: themselves and their agents, and the members
/// of their groups and their friends, with theirs.
async fn reachable_seen_by(app: &App, db: &mut Db, me: &str) -> Result<Vec<Reachable>> {
  let people: HashSet<String> = sqlx::query_scalar(
    r#"SELECT b.account FROM group_member a JOIN group_member b ON b."group" = a."group" WHERE a.account = ?1
       UNION SELECT f."to" FROM friend f JOIN friend r ON r."from" = f."to" AND r."to" = f."from" WHERE f."from" = ?1
       UNION SELECT ?1"#,
  )
  .bind(me)
  .fetch_all(&mut *db)
  .await?
  .into_iter()
  .collect();
  let mut reachable = Vec::new();
  for (account, id, presence) in app.live.reachable() {
    if !people.contains(&account) {
      continue;
    }
    let name: Option<String> = sqlx::query_scalar(
      "SELECT CASE WHEN ?2 = a.id THEN a.login ELSE a.login || '/' || ag.name END
       FROM account a LEFT JOIN agent ag ON ag.id = ?2 AND ag.account = a.id WHERE a.id = ?1",
    )
    .bind(&account)
    .bind(&id)
    .fetch_optional(&mut *db)
    .await?
    .flatten();
    if let Some(name) = name {
      reachable.push(Reachable { id, name, presence });
    }
  }
  reachable.sort_by(|a, b| a.name.cmp(&b.name));
  Ok(reachable)
}

/// Everything `me` sees at once, but its version.
async fn overview_of(app: &App, db: &mut Db, me: &str) -> Result<Overview> {
  let sessions = sessions_of(db, me).await?;
  let mut projects = Vec::new();
  for project in projects_of(db, me).await? {
    let project = project_json(db, &project).await?;
    let sessions = sessions
      .iter()
      .filter(|s| s.project.as_ref().is_some_and(|p| p.id == project.id))
      .cloned()
      .collect();
    projects.push(ProjectOverview { project, sessions });
  }
  let mut groups = Vec::new();
  for group in groups_of(db, me).await? {
    let group = group_json(db, &group).await?;
    groups.push(GroupOverview {
      sessions: sessions
        .iter()
        .filter(|s| s.project.is_none() && s.group.as_ref().is_some_and(|g| g.id == group.id))
        .cloned()
        .collect(),
      projects: projects
        .iter()
        .filter(|p| p.project.group.id == group.id)
        .cloned()
        .collect(),
      group,
    });
  }
  Ok(Overview {
    account: account_json(db, me).await?,
    groups,
    dms: dms_of(db, me).await?,
    friends: friends_of(db, me).await?,
    agents: agents_of(app, db, me, false).await?,
    reachable: reachable_seen_by(app, db, me).await?,
    version: String::new(),
  })
}

/// Everything the account sees at once; with `version`, once it differs from it.
pub async fn overview(
  State(app): State<App>,
  caller: Caller,
  Query(query): Query<OverviewQuery>,
) -> Result<Json<Overview>> {
  if query.wait.is_some_and(|wait| wait > MAX_WAIT) {
    return Err(Refusal::bad(format!("wait: at most {MAX_WAIT} seconds.")));
  }
  let (app, account) = (&app, &caller.account);
  let current = move || async move {
    let mut db = app.db.acquire().await?;
    let mut overview = overview_of(app, &mut db, account).await?;
    overview.version = version_of(&overview);
    Ok(overview)
  };
  let overview = match &query.version {
    None => current().await?,
    Some(version) => {
      app
        .changes
        .changed(
          &caller.account,
          current,
          |o| o.version != *version,
          query.wait,
        )
        .await?
    }
  };
  Ok(Json(overview))
}

#[derive(sqlx::FromRow)]
struct ActivityRow {
  login: String,
  name: String,
  operation: String,
  arguments: String,
  created: String,
}

/// What the account's tokens changed in it, newest first, at most the last 200.
pub async fn activity(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Activity>>> {
  let rows: Vec<ActivityRow> = sqlx::query_as(
    "SELECT login, name, operation, arguments, created FROM activity WHERE account = ? ORDER BY id DESC LIMIT 200",
  )
  .bind(&caller.account)
  .fetch_all(&app.db)
  .await?;
  Ok(Json(
    rows
      .into_iter()
      .map(|row| Activity {
        arguments: serde_json::from_str(&row.arguments).unwrap_or(Value::String(row.arguments)),
        login: row.login,
        agent: row.name,
        operation: row.operation,
        created: row.created,
      })
      .collect(),
  ))
}

/// Deletes the account with its logins and its DMs, and every group it is the last member of;
/// it leaves the other groups. Only the person does this, in the browser.
pub async fn delete(State(app): State<App>, caller: Caller) -> Result<StatusCode> {
  caller.in_browser()?;
  let mut tx = app.db.begin().await?;
  sqlx::query(
    r#"DELETE FROM "group" WHERE id IN (SELECT "group" FROM group_member WHERE account = ?1)
       AND NOT EXISTS (SELECT 1 FROM group_member m WHERE m."group" = "group".id AND m.account != ?1)"#,
  )
  .bind(&caller.account)
  .execute(&mut *tx)
  .await?;
  sqlx::query("DELETE FROM account WHERE id = ?")
    .bind(&caller.account)
    .execute(&mut *tx)
    .await?;
  tx.commit().await?;
  transport::end_account(&app, &caller.account);
  Ok(StatusCode::NO_CONTENT)
}

// Agents.

#[derive(sqlx::FromRow)]
struct AgentRow {
  id: String,
  name: String,
  seen: Option<String>,
  archived: Option<String>,
}

async fn agent_json(
  app: &App,
  db: &mut Db,
  account: &str,
  login: &str,
  row: AgentRow,
) -> Result<Agent> {
  let presence = if row.archived.is_some() {
    Presence::Archived
  } else {
    app.live.presence(&row.id)
  };
  let sessions: Vec<String> = sqlx::query_scalar(
    "SELECT session FROM participant WHERE id = ? AND inside = 1 ORDER BY since",
  )
  .bind(&row.id)
  .fetch_all(&mut *db)
  .await?;
  let mut listening = Vec::new();
  for id in sessions {
    if let Some(session) = session_for(db, &id, account).await? {
      listening.push(Named {
        id,
        name: session.name,
      });
    }
  }
  Ok(Agent {
    status: status_of(db, &row.id).await?,
    seen: row
      .seen
      .filter(|_| matches!(presence, Presence::Offline | Presence::Archived)),
    name: format!("{login}/{}", row.name),
    id: row.id,
    presence,
    listening,
  })
}

/// The account's agents, awake or asleep first, then the ones seen last first, and the archived
/// last.
async fn agents_of(app: &App, db: &mut Db, account: &str, archived: bool) -> Result<Vec<Agent>> {
  let login: String = sqlx::query_scalar("SELECT login FROM account WHERE id = ?")
    .bind(account)
    .fetch_one(&mut *db)
    .await?;
  let rows: Vec<AgentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
    "SELECT id, name, seen, archived FROM agent WHERE account = ? {}
     ORDER BY archived IS NOT NULL, coalesce(seen, created) DESC, name",
    if archived { "" } else { "AND archived IS NULL" }
  )))
  .bind(account)
  .fetch_all(&mut *db)
  .await?;
  let mut agents = Vec::new();
  for row in rows {
    agents.push(agent_json(app, db, account, &login, row).await?);
  }
  agents.sort_by_key(|a| !matches!(a.presence, Presence::Awake | Presence::Asleep));
  Ok(agents)
}

async fn agent_of(db: &mut Db, id: &str, account: &str) -> Result<AgentRow> {
  sqlx::query_as("SELECT id, name, seen, archived FROM agent WHERE id = ? AND account = ?")
    .bind(id)
    .bind(account)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| Refusal::not_found("No such agent."))
}

fn check_agent_name(name: &str) -> Result<()> {
  match is_name_part(name) {
    true => Ok(()),
    false => Err(Refusal::bad(
      "name: lower case letters, digits and hyphens, starting with a letter or digit.",
    )),
  }
}

fn taken(name: &str) -> Refusal {
  Refusal::conflict(format!(
    "Another agent of this account is named {name}: pick another, such as {name}-2."
  ))
}

/// A new agent's id: `a_` and 8 letters or digits, short and no secret, since a token is the key.
fn new_agent_id() -> String {
  format!(
    "a_{}",
    db::random_code("abcdefghijklmnopqrstuvwxyz0123456789", 8)
  )
}

/// Creates an agent of the account: a token creates its own, which it holds from the start.
pub async fn create_agent(
  State(app): State<App>,
  caller: Caller,
  Body(input): Body<NameBody>,
) -> Result<(StatusCode, Json<Agent>)> {
  check_agent_name(&input.name)?;
  let mut db = app.db.acquire().await?;
  if db::count(
    &mut db,
    "SELECT count(*) FROM agent WHERE account = ? AND archived IS NULL",
    &[&caller.account],
  )
  .await?
    >= MAX_AGENTS
  {
    return Err(Refusal::forbidden(format!(
      "An account has at most {MAX_AGENTS} agents that are not archived: archive one first."
    )));
  }
  if db::count(
    &mut db,
    "SELECT count(*) FROM agent WHERE account = ?",
    &[&caller.account],
  )
  .await?
    >= MAX_AGENTS_EVER
  {
    return Err(Refusal::forbidden(format!(
      "An account has at most {MAX_AGENTS_EVER} agents, archived ones included."
    )));
  }
  let now = db::now();
  let holder = (caller.kind != vibetogether_protocol::LoginKind::Browser).then_some(&caller.login);
  let mut id = new_agent_id();
  while db::count(&mut db, "SELECT count(*) FROM agent WHERE id = ?", &[&id]).await? > 0 {
    id = new_agent_id();
  }
  let inserted = sqlx::query(
    "INSERT INTO agent (id, account, name, holder, seen, created) VALUES (?, ?, ?, ?, ?, ?)",
  )
  .bind(&id)
  .bind(&caller.account)
  .bind(&input.name)
  .bind(holder)
  .bind(holder.map(|_| &now))
  .bind(&now)
  .execute(&mut *db)
  .await;
  match inserted {
    Err(e) if is_taken(&e) => return Err(taken(&input.name)),
    other => other?,
  };
  caller
    .record(&mut db, "create_agent", json!({ "name": input.name }))
    .await?;
  let row = agent_of(&mut db, &id, &caller.account).await?;
  Ok((
    StatusCode::CREATED,
    Json(agent_json(&app, &mut db, &caller.account, &caller.person, row).await?),
  ))
}

/// The account's agents, the archived included.
pub async fn agents(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Agent>>> {
  let mut db = app.db.acquire().await?;
  Ok(Json(agents_of(&app, &mut db, &caller.account, true).await?))
}

/// Renames an agent, at any time; its id stays.
pub async fn rename_agent(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
  Body(input): Body<NameBody>,
) -> Result<Json<Agent>> {
  check_agent_name(&input.name)?;
  let mut db = app.db.acquire().await?;
  let row = agent_of(&mut db, &id, &caller.account).await?;
  if row.archived.is_some() {
    return Err(Refusal::forbidden("An archived agent keeps its last name."));
  }
  let renamed = sqlx::query("UPDATE agent SET name = ? WHERE id = ?")
    .bind(&input.name)
    .bind(&row.id)
    .execute(&mut *db)
    .await;
  match renamed {
    Err(e) if is_taken(&e) => return Err(taken(&input.name)),
    other => other?,
  };
  caller
    .record(
      &mut db,
      "rename_agent",
      json!({ "id": id, "name": input.name }),
    )
    .await?;
  let row = AgentRow {
    name: input.name,
    ..row
  };
  Ok(Json(
    agent_json(&app, &mut db, &caller.account, &caller.person, row).await?,
  ))
}

/// Archives an agent that won't come back. It can't be undone.
pub async fn archive_agent(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  let mut db = app.db.acquire().await?;
  let row = agent_of(&mut db, &id, &caller.account).await?;
  if row.archived.is_none() {
    let p = transport::Acting {
      account: caller.account.clone(),
      id: row.id.clone(),
      name: format!("{}/{}", caller.person, row.name),
    };
    transport::archive(&app, &mut db, &p).await?;
    caller
      .record(&mut db, "archive_agent", json!({ "id": id }))
      .await?;
  }
  Ok(StatusCode::NO_CONTENT)
}

/// Sets the caller's status, one for all sessions; empty clears it. It wakes no one.
pub async fn set_status(
  State(app): State<App>,
  caller: Caller,
  Query(query): Query<AgentQuery>,
  Body(input): Body<StatusBody>,
) -> Result<StatusCode> {
  let text = input.text.trim();
  if text.chars().count() > 500 || text.chars().any(char::is_control) {
    return Err(Refusal::bad("text: one line of at most 500 characters."));
  }
  let mut db = app.db.acquire().await?;
  let p = transport::acting(&mut db, &caller, query.agent.as_deref()).await?;
  transport::hold(&app, &mut db, &p, &caller.login).await?;
  if text.is_empty() {
    sqlx::query("DELETE FROM status WHERE participant = ?")
      .bind(&p.id)
      .execute(&mut *db)
      .await?;
  } else {
    sqlx::query(
      "INSERT INTO status (participant, account, text) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET text = excluded.text",
    )
    .bind(&p.id)
    .bind(&p.account)
    .bind(text)
    .execute(&mut *db)
    .await?;
  }
  Ok(StatusCode::NO_CONTENT)
}
