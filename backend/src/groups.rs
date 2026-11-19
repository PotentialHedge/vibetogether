//! Groups, their members, people and agents, and their projects with the GitHub repositories
//! each points at.
//!
//! A member is a person, by their account's id, or an agent, by its id, each with its person
//! (`group_member`). An agent is in its person's own group from its creation, and in another only
//! while its person is, once its person added it.

use axum::{Json, extract::State, http::StatusCode};
use serde_json::json;
use sqlx::Connection;
use vibetogether_protocol::{
  ChangeProject, CreateProject, Group, GroupAgent, NameBody, Named, Presence, Project, is_name_part,
};

use crate::{
  App,
  caller::Caller,
  db::{
    self, Db, MAX_GROUPS, MAX_MEMBERS, TRASH_DAYS, are_friends, general_of, is_member, own_group_of,
  },
  error::{Refusal, Result},
  extract::{Json as Body, Path},
  transport::{self, participant_by_name, quoted},
  trash,
};

/// The most projects one group holds.
const MAX_PROJECTS: i64 = 50;
/// The most repositories one project points at.
const MAX_REPOS: usize = 20;
const GITHUB: &str = "https://github.com/";

/// A name as one is given: trimmed, of 1 to 100 characters, on one line.
pub fn check_name(name: &str) -> Result<String> {
  let name = name.trim();
  if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
    return Err(Refusal::bad(
      "name: 1 to 100 characters, on one line, with no control characters.",
    ));
  }
  Ok(name.to_string())
}

/// A GitHub repository as `owner/name`, from that or its URL, with or without `.git`: GitHub's
/// owners are letters, digits and inner hyphens, at most 39, its repositories' names letters,
/// digits, `.`, `_` and `-`, at most 100, but never `.` or `..`.
fn repo_of(given: &str) -> Option<String> {
  let repo = given.trim();
  let repo = repo.strip_prefix(GITHUB).unwrap_or(repo);
  let repo = repo.strip_suffix('/').unwrap_or(repo);
  let repo = repo.strip_suffix(".git").unwrap_or(repo);
  let (owner, name) = repo.split_once('/')?;
  let owner_ok = (1..=39).contains(&owner.len())
    && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    && !owner.starts_with('-')
    && !owner.ends_with('-');
  let name_ok = (1..=100).contains(&name.len())
    && name
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
    && name != "."
    && name != "..";
  (owner_ok && name_ok).then(|| format!("{owner}/{name}"))
}

/// The repositories as a request gives them, each once, regardless of case.
fn repos_of_input(given: &[String]) -> Result<Vec<String>> {
  let bad = || {
    Refusal::bad(format!(
      "repos: at most {MAX_REPOS}, each a GitHub repository, as owner/name or its URL."
    ))
  };
  if given.len() > MAX_REPOS {
    return Err(bad());
  }
  let mut repos: Vec<String> = Vec::new();
  for each in given {
    let repo = repo_of(each).ok_or_else(bad)?;
    if !repos.iter().any(|r| r.eq_ignore_ascii_case(&repo)) {
      repos.push(repo);
    }
  }
  Ok(repos)
}

/// The repositories `project` points at, as their URLs.
pub async fn repos_of(db: &mut Db, project: &str) -> Result<Vec<String>> {
  let repos: Vec<String> =
    sqlx::query_scalar("SELECT repo FROM project_repo WHERE project = ? ORDER BY position")
      .bind(project)
      .fetch_all(db)
      .await?;
  Ok(
    repos
      .into_iter()
      .map(|repo| format!("{GITHUB}{repo}"))
      .collect(),
  )
}

async fn set_repos(db: &mut Db, project: &str, repos: &[String]) -> Result<()> {
  sqlx::query("DELETE FROM project_repo WHERE project = ?")
    .bind(project)
    .execute(&mut *db)
    .await?;
  for (position, repo) in repos.iter().enumerate() {
    sqlx::query("INSERT INTO project_repo (project, position, repo) VALUES (?, ?, ?)")
      .bind(project)
      .bind(position as i64)
      .bind(repo)
      .execute(&mut *db)
      .await?;
  }
  Ok(())
}

#[derive(sqlx::FromRow, Clone)]
pub struct GroupRow {
  pub id: String,
  pub name: String,
  pub person: Option<String>,
}

/// The group, where `who`, a person or an agent, is in it: to anyone else no group shows, nor
/// one in the trash.
pub async fn group_for(db: &mut Db, id: &str, who: &str) -> Result<GroupRow> {
  let group: Option<GroupRow> =
    sqlx::query_as(r#"SELECT id, name, person FROM "group" WHERE id = ?"#)
      .bind(id)
      .fetch_optional(&mut *db)
      .await?;
  match group {
    Some(group) if is_member(db, &group.id, who).await? => Ok(group),
    _ => Err(Refusal::not_found("No such group.")),
  }
}

/// The groups `who`, a person or an agent, is in, its person's own first.
pub async fn groups_of(db: &mut Db, who: &str) -> Result<Vec<GroupRow>> {
  Ok(
    sqlx::query_as(
      r#"SELECT g.id, g.name, g.person FROM "group" g JOIN group_member m ON m."group" = g.id
         WHERE m.member = ? AND g.trashed IS NULL ORDER BY g.person IS NULL, g.created"#,
    )
    .bind(who)
    .fetch_all(db)
    .await?,
  )
}

#[derive(sqlx::FromRow)]
struct AgentMember {
  id: String,
  name: String,
  archived: bool,
}

pub async fn group_json(app: &App, db: &mut Db, group: &GroupRow) -> Result<Group> {
  let members: Vec<String> = sqlx::query_scalar(
    r#"SELECT a.login FROM group_member m JOIN account a ON a.id = m.member WHERE m."group" = ? ORDER BY a.login"#,
  )
  .bind(&group.id)
  .fetch_all(&mut *db)
  .await?;
  let agents: Vec<AgentMember> = sqlx::query_as(
    r#"SELECT ag.id, a.login || '/' || ag.name AS name, ag.archived IS NOT NULL AS archived
       FROM group_member m JOIN agent ag ON ag.id = m.member JOIN account a ON a.id = ag.account
       WHERE m."group" = ? ORDER BY a.login, ag.name"#,
  )
  .bind(&group.id)
  .fetch_all(db)
  .await?;
  Ok(Group {
    id: group.id.clone(),
    name: group.name.clone(),
    own: group.person.is_some(),
    members,
    agents: agents
      .into_iter()
      .map(|agent| GroupAgent {
        presence: match agent.archived {
          true => Presence::Archived,
          false => app.live.presence(&agent.id),
        },
        id: agent.id,
        name: agent.name,
      })
      .collect(),
  })
}

/// A member to be, or one, as `name` gives it, by the rule a mention follows: `<person>/<agent>`
/// that agent, which is not archived; a name without `/` the caller's person's agent of that name
/// where there is one, else a person. Its person, its id, and its full name.
async fn member_named(
  db: &mut Db,
  caller: &Caller,
  name: &str,
) -> Result<Option<(String, String, String)>> {
  let own = format!("{}/{name}", caller.person);
  let full = match is_name_part(name) {
    true if participant_by_name(db, &own).await?.is_some() => own,
    _ => name.to_string(),
  };
  Ok(
    participant_by_name(db, &full)
      .await?
      .map(|(account, id)| (account, id, full)),
  )
}

/// The groups the caller is in, its person's own first.
pub async fn list(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Group>>> {
  let mut db = app.db.acquire().await?;
  let mut groups = Vec::new();
  for group in groups_of(&mut db, caller.who()).await? {
    groups.push(group_json(&app, &mut db, &group).await?);
  }
  Ok(Json(groups))
}

async fn groups_besides_own(db: &mut Db, account: &str) -> Result<i64> {
  db::count(
    db,
    r#"SELECT count(*) FROM group_member m JOIN "group" g ON g.id = m."group" WHERE m.member = ? AND g.person IS NULL AND g.trashed IS NULL"#,
    &[account],
  )
  .await
}

/// Takes `member` out of the group, and out of every session of the group it is in.
async fn take_out(app: &App, db: &mut Db, group: &str, member: &str) -> Result<()> {
  sqlx::query(r#"DELETE FROM group_member WHERE "group" = ? AND member = ?"#)
    .bind(group)
    .bind(member)
    .execute(&mut *db)
    .await?;
  transport::leave_group(app, db, group, member).await
}

/// The people in a group; its agents count not.
async fn people_in(db: &mut Db, group: &str) -> Result<i64> {
  db::count(
    db,
    r#"SELECT count(*) FROM group_member WHERE "group" = ? AND member = account"#,
    &[group],
  )
  .await
}

/// Creates a group, with the caller's person as its first member, and its general; an agent
/// creating it is in it too.
pub async fn create(
  State(app): State<App>,
  caller: Caller,
  Body(input): Body<NameBody>,
) -> Result<(StatusCode, Json<Group>)> {
  let name = check_name(&input.name)?;
  let mut db = app.db.acquire().await?;
  if groups_besides_own(&mut db, &caller.account).await? >= MAX_GROUPS {
    return Err(Refusal::forbidden(format!(
      "A person creates a group only while in fewer than {MAX_GROUPS} besides their own: leave one first."
    )));
  }
  let group = GroupRow {
    id: db::new_id("g"),
    name,
    person: None,
  };
  let mut tx = db.begin().await?;
  sqlx::query(r#"INSERT INTO "group" (id, name, created) VALUES (?, ?, ?)"#)
    .bind(&group.id)
    .bind(&group.name)
    .bind(db::now())
    .execute(&mut *tx)
    .await?;
  for member in [caller.account.as_str(), caller.who()] {
    sqlx::query(
      r#"INSERT OR IGNORE INTO group_member ("group", member, account) VALUES (?, ?, ?)"#,
    )
    .bind(&group.id)
    .bind(member)
    .bind(&caller.account)
    .execute(&mut *tx)
    .await?;
  }
  let general = general_of(&mut tx, &group.id).await?;
  tx.commit().await?;
  let text = format!(
    "{} created the group {}.",
    caller.actor(),
    quoted(&group.name)
  );
  transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
  caller
    .record(&mut db, "create_group", json!({ "name": group.name }))
    .await?;
  Ok((
    StatusCode::CREATED,
    Json(group_json(&app, &mut db, &group).await?),
  ))
}

/// Renames a group; one's own is named after them.
pub async fn rename(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
  Body(input): Body<NameBody>,
) -> Result<Json<Group>> {
  let name = check_name(&input.name)?;
  let mut db = app.db.acquire().await?;
  let group = group_for(&mut db, &id, caller.who()).await?;
  if group.person.is_some() {
    return Err(Refusal::forbidden("Your own group is named after you."));
  }
  sqlx::query(r#"UPDATE "group" SET name = ? WHERE id = ?"#)
    .bind(&name)
    .bind(&group.id)
    .execute(&mut *db)
    .await?;
  caller
    .record(&mut db, "rename_group", json!({ "id": id, "name": name }))
    .await?;
  Ok(Json(
    group_json(&app, &mut db, &GroupRow { name, ..group }).await?,
  ))
}

/// Deletes a group, with its projects and their sessions, into the trash; one's own group stays.
/// Any member does it, an agent too, Luis's decision (2026-11-19).
pub async fn delete(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  let mut db = app.db.acquire().await?;
  let group = group_for(&mut db, &id, caller.who()).await?;
  if group.person.is_some() {
    return Err(Refusal::forbidden(
      "Your own group stays as long as you do.",
    ));
  }
  let others: Vec<String> = sqlx::query_scalar(
    r#"SELECT member FROM group_member WHERE "group" = ? AND member = account AND account != ?"#,
  )
  .bind(&group.id)
  .bind(&caller.account)
  .fetch_all(&mut *db)
  .await?;
  trash::put(&mut db, "group", &group.id, &caller).await?;
  for other in others {
    let own = own_group_of(&mut db, &other).await?;
    let inbox = general_of(&mut db, &own).await?;
    let text = format!(
      "{} deleted the group {}, into the trash, where its members restore it within {TRASH_DAYS} days.",
      caller.actor(),
      quoted(&group.name)
    );
    transport::announce(&app, &mut db, &inbox, &text, &[], &[]).await?;
  }
  caller
    .record(&mut db, "delete_group", json!({ "id": id }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

/// Adds a friend of the caller to a group, or an agent of the caller's, which lets it in; one's
/// own group holds them and their agents alone. A name is taken as a mention takes it
/// (`member_named`).
pub async fn add_member(
  State(app): State<App>,
  caller: Caller,
  Path((id, name)): Path<(String, String)>,
) -> Result<Json<Group>> {
  caller.as_person()?;
  let mut db = app.db.acquire().await?;
  caller.limit(&mut db, "add_group_member").await?;
  let group = group_for(&mut db, &id, &caller.account).await?;
  let found = member_named(&mut db, &caller, &name).await?;
  if let Some((account, agent, full)) = found.clone().filter(|(a, id, _)| a != id) {
    if account != caller.account {
      return Err(Refusal::forbidden(
        "Only its person adds an agent to a group.",
      ));
    }
    if !is_member(&mut db, &group.id, &agent).await? {
      sqlx::query(r#"INSERT INTO group_member ("group", member, account) VALUES (?, ?, ?)"#)
        .bind(&group.id)
        .bind(&agent)
        .bind(&account)
        .execute(&mut *db)
        .await?;
      let general = general_of(&mut db, &group.id).await?;
      let text = format!("{} added {full} to the group.", caller.actor());
      transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
      caller
        .record(
          &mut db,
          "add_group_member",
          json!({ "id": id, "name": full }),
        )
        .await?;
    }
    return Ok(Json(group_json(&app, &mut db, &group).await?));
  }
  if group.person.is_some() {
    return Err(Refusal::forbidden(
      "Your own group holds you and your agents alone.",
    ));
  }
  let Some((person, _, login)) = found else {
    return Err(Refusal::not_found(
      "No such person or agent on Vibe Together: an invite to the group (create_invite with group) reaches someone new.",
    ));
  };
  if is_member(&mut db, &group.id, &person).await? {
    return Ok(Json(group_json(&app, &mut db, &group).await?));
  }
  if !are_friends(&mut db, &caller.account, &person).await? {
    return Err(Refusal::forbidden(
      "Only a friend of yours becomes a member through you: an invite to the group (create_invite with group) makes them both.",
    ));
  }
  if groups_besides_own(&mut db, &person).await? >= MAX_GROUPS {
    return Err(Refusal::forbidden(format!(
      "{login} is in {MAX_GROUPS} groups besides their own: they leave one first."
    )));
  }
  if people_in(&mut db, &group.id).await? >= MAX_MEMBERS {
    return Err(Refusal::forbidden(format!(
      "A group has at most {MAX_MEMBERS} people."
    )));
  }
  sqlx::query(r#"INSERT INTO group_member ("group", member, account) VALUES (?, ?, ?)"#)
    .bind(&group.id)
    .bind(&person)
    .bind(&person)
    .execute(&mut *db)
    .await?;
  let general = general_of(&mut db, &group.id).await?;
  let text = format!("{} added {login} to the group.", caller.actor());
  transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
  let own = own_group_of(&mut db, &person).await?;
  let inbox = general_of(&mut db, &own).await?;
  let text = format!(
    "{} added you to the group {}.",
    caller.actor(),
    quoted(&group.name)
  );
  transport::announce(&app, &mut db, &inbox, &text, &[], &[]).await?;
  caller
    .record(
      &mut db,
      "add_group_member",
      json!({ "id": id, "name": name }),
    )
    .await?;
  Ok(Json(group_json(&app, &mut db, &group).await?))
}

/// Removes a member, the caller included, as one leaves: an agent any member removes, and it
/// leaves itself; a person only a person removes, with their agents, and the last one leaves
/// only by deleting the group. Whoever goes leaves the group's sessions. An agent stays in its
/// person's own group.
pub async fn remove_member(
  State(app): State<App>,
  caller: Caller,
  Path((id, name)): Path<(String, String)>,
) -> Result<StatusCode> {
  let mut db = app.db.acquire().await?;
  let group = group_for(&mut db, &id, caller.who()).await?;
  let found = member_named(&mut db, &caller, &name).await?;
  let Some((person, member, login)) = found else {
    return Err(Refusal::not_found("No such member."));
  };
  if !is_member(&mut db, &group.id, &member).await? {
    return Err(Refusal::not_found("No such member."));
  }
  let general = general_of(&mut db, &group.id).await?;
  if person != member {
    if group.person.is_some() {
      return Err(Refusal::forbidden(
        "An agent is in its person's own group as long as it is.",
      ));
    }
    take_out(&app, &mut db, &group.id, &member).await?;
    let text = match member == caller.who() {
      true => format!("{login} left the group."),
      false => format!("{} removed {login} from the group.", caller.actor()),
    };
    transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
    caller
      .record(
        &mut db,
        "remove_group_member",
        json!({ "id": id, "name": login }),
      )
      .await?;
    return Ok(StatusCode::NO_CONTENT);
  }
  caller.as_person()?;
  if group.person.is_some() {
    return Err(Refusal::forbidden(
      "Your own group holds you and your agents alone.",
    ));
  }
  if people_in(&mut db, &group.id).await? == 1 {
    return Err(Refusal::conflict(
      "This is the group's last member: delete the group instead, which deletes its projects and sessions.",
    ));
  }
  let agents: Vec<String> = sqlx::query_scalar(
    r#"SELECT member FROM group_member WHERE "group" = ? AND account = ? AND member != account"#,
  )
  .bind(&group.id)
  .bind(&person)
  .fetch_all(&mut *db)
  .await?;
  for gone in agents.iter().chain([&person]) {
    take_out(&app, &mut db, &group.id, gone).await?;
  }
  let own = person == caller.account;
  let general = general_of(&mut db, &group.id).await?;
  let text = match own {
    true => format!("{login} left the group."),
    false => format!("{} removed {login} from the group.", caller.actor()),
  };
  transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
  if !own {
    let mine = own_group_of(&mut db, &person).await?;
    let inbox = general_of(&mut db, &mine).await?;
    let text = format!(
      "{} removed you from the group {}.",
      caller.actor(),
      quoted(&group.name)
    );
    transport::announce(&app, &mut db, &inbox, &text, &[], &[]).await?;
  }
  caller
    .record(
      &mut db,
      "remove_group_member",
      json!({ "id": id, "name": name }),
    )
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

// Projects.

#[derive(sqlx::FromRow)]
pub struct ProjectRow {
  pub id: String,
  pub name: String,
  pub group: String,
}

/// The project, where `who`, a person or an agent, is in its group, and it is not in the trash.
pub async fn project_for(db: &mut Db, id: &str, who: &str) -> Result<ProjectRow> {
  let project: Option<ProjectRow> =
    sqlx::query_as(r#"SELECT id, name, "group" FROM project WHERE id = ? AND trashed IS NULL"#)
      .bind(id)
      .fetch_optional(&mut *db)
      .await?;
  match project {
    Some(project) if is_member(db, &project.group, who).await? => Ok(project),
    _ => Err(Refusal::not_found("No such project.")),
  }
}

/// The projects of the groups `who`, a person or an agent, is in.
pub async fn projects_of(db: &mut Db, who: &str) -> Result<Vec<ProjectRow>> {
  Ok(
    sqlx::query_as(
      r#"SELECT p.id, p.name, p."group" FROM project p JOIN group_member m ON m."group" = p."group"
         JOIN "group" g ON g.id = p."group"
         WHERE m.member = ? AND p.trashed IS NULL AND g.trashed IS NULL ORDER BY p.created"#,
    )
    .bind(who)
    .fetch_all(db)
    .await?,
  )
}

pub async fn project_json(db: &mut Db, project: &ProjectRow) -> Result<Project> {
  let group: String = sqlx::query_scalar(r#"SELECT name FROM "group" WHERE id = ?"#)
    .bind(&project.group)
    .fetch_one(&mut *db)
    .await?;
  Ok(Project {
    id: project.id.clone(),
    name: project.name.clone(),
    group: Named {
      id: project.group.clone(),
      name: group,
    },
    repos: repos_of(db, &project.id).await?,
  })
}

/// The projects of the caller's groups.
pub async fn projects(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Project>>> {
  let mut db = app.db.acquire().await?;
  let mut projects = Vec::new();
  for project in projects_of(&mut db, caller.who()).await? {
    projects.push(project_json(&mut db, &project).await?);
  }
  Ok(Json(projects))
}

/// Creates a project in a group, or in the caller's own where `group` is left out.
pub async fn create_project(
  State(app): State<App>,
  caller: Caller,
  Body(input): Body<CreateProject>,
) -> Result<(StatusCode, Json<Project>)> {
  let name = check_name(&input.name)?;
  let repos = repos_of_input(input.repos.as_deref().unwrap_or_default())?;
  let mut db = app.db.acquire().await?;
  let group = match &input.group {
    Some(group) => group.clone(),
    None => own_group_of(&mut db, &caller.account).await?,
  };
  let group = group_for(&mut db, &group, caller.who()).await?;
  if db::count(
    &mut db,
    r#"SELECT count(*) FROM project WHERE "group" = ? AND trashed IS NULL"#,
    &[&group.id],
  )
  .await?
    >= MAX_PROJECTS
  {
    return Err(Refusal::forbidden(format!(
      "A group has at most {MAX_PROJECTS} projects: delete one first."
    )));
  }
  let project = ProjectRow {
    id: db::new_id("p"),
    name,
    group: group.id.clone(),
  };
  let mut tx = db.begin().await?;
  sqlx::query(r#"INSERT INTO project (id, name, "group", created) VALUES (?, ?, ?, ?)"#)
    .bind(&project.id)
    .bind(&project.name)
    .bind(&project.group)
    .bind(db::now())
    .execute(&mut *tx)
    .await?;
  set_repos(&mut tx, &project.id, &repos).await?;
  tx.commit().await?;
  let general = general_of(&mut db, &group.id).await?;
  let text = format!(
    "{} created the project {}.",
    caller.actor(),
    quoted(&project.name)
  );
  transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
  caller
    .record(
      &mut db,
      "create_project",
      json!({ "name": project.name, "group": input.group, "repos": repos }),
    )
    .await?;
  Ok((
    StatusCode::CREATED,
    Json(project_json(&mut db, &project).await?),
  ))
}

/// Renames a project, points it at other repositories in place of its own, or both.
pub async fn change_project(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
  Body(input): Body<ChangeProject>,
) -> Result<Json<Project>> {
  let name = input.name.as_deref().map(check_name).transpose()?;
  let repos = input.repos.as_deref().map(repos_of_input).transpose()?;
  let mut db = app.db.acquire().await?;
  let project = project_for(&mut db, &id, caller.who()).await?;
  let name = name.unwrap_or(project.name.clone());
  let mut tx = db.begin().await?;
  sqlx::query("UPDATE project SET name = ? WHERE id = ?")
    .bind(&name)
    .bind(&project.id)
    .execute(&mut *tx)
    .await?;
  if let Some(repos) = &repos {
    set_repos(&mut tx, &project.id, repos).await?;
  }
  tx.commit().await?;
  caller
    .record(
      &mut db,
      "change_project",
      json!({ "id": id, "name": input.name, "repos": repos }),
    )
    .await?;
  Ok(Json(
    project_json(&mut db, &ProjectRow { name, ..project }).await?,
  ))
}

/// Deletes a project, with its sessions, into the trash. Any member of its group does it, an
/// agent too.
pub async fn delete_project(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  let mut db = app.db.acquire().await?;
  let project = project_for(&mut db, &id, caller.who()).await?;
  trash::put(&mut db, "project", &project.id, &caller).await?;
  let general = general_of(&mut db, &project.group).await?;
  let text = format!(
    "{} deleted the project {}, with its sessions, into the trash, where the group's members restore it within {TRASH_DAYS} days.",
    caller.actor(),
    quoted(&project.name)
  );
  transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
  caller
    .record(&mut db, "delete_project", json!({ "id": id }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}
