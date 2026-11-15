//! Groups, their members, and their projects with the GitHub repositories each points at.

use axum::{Json, extract::State, http::StatusCode};
use serde_json::json;
use sqlx::Connection;
use vibetogether_protocol::{ChangeProject, CreateProject, Group, NameBody, Named, Project};

use crate::{
  App,
  caller::Caller,
  db::{self, Db, MAX_GROUPS, MAX_MEMBERS, are_friends, general_of, is_member, own_group_of},
  error::{Refusal, Result},
  extract::{Json as Body, Path},
  transport::{self, quoted},
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

/// The group, where `account` is in it: to anyone else no group shows.
async fn group_for(db: &mut Db, id: &str, account: &str) -> Result<GroupRow> {
  let group: Option<GroupRow> =
    sqlx::query_as(r#"SELECT id, name, person FROM "group" WHERE id = ?"#)
      .bind(id)
      .fetch_optional(&mut *db)
      .await?;
  match group {
    Some(group) if is_member(db, &group.id, account).await? => Ok(group),
    _ => Err(Refusal::not_found("No such group.")),
  }
}

/// The groups `account` is in, their own first.
pub async fn groups_of(db: &mut Db, account: &str) -> Result<Vec<GroupRow>> {
  Ok(
    sqlx::query_as(
      r#"SELECT g.id, g.name, g.person FROM "group" g JOIN group_member m ON m."group" = g.id
         WHERE m.account = ? ORDER BY g.person IS NULL, g.created"#,
    )
    .bind(account)
    .fetch_all(db)
    .await?,
  )
}

pub async fn group_json(db: &mut Db, group: &GroupRow) -> Result<Group> {
  let members: Vec<String> = sqlx::query_scalar(
    r#"SELECT a.login FROM group_member m JOIN account a ON a.id = m.account WHERE m."group" = ? ORDER BY a.login"#,
  )
  .bind(&group.id)
  .fetch_all(db)
  .await?;
  Ok(Group {
    id: group.id.clone(),
    name: group.name.clone(),
    own: group.person.is_some(),
    members,
  })
}

async fn person_by_login(db: &mut Db, login: &str) -> Result<Option<(String, String)>> {
  Ok(
    sqlx::query_as("SELECT id, login FROM account WHERE login = ?")
      .bind(login)
      .fetch_optional(db)
      .await?,
  )
}

/// The groups the caller is in, their own first.
pub async fn list(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Group>>> {
  let mut db = app.db.acquire().await?;
  let mut groups = Vec::new();
  for group in groups_of(&mut db, &caller.account).await? {
    groups.push(group_json(&mut db, &group).await?);
  }
  Ok(Json(groups))
}

async fn groups_besides_own(db: &mut Db, account: &str) -> Result<i64> {
  db::count(
    db,
    r#"SELECT count(*) FROM group_member m JOIN "group" g ON g.id = m."group" WHERE m.account = ? AND g.person IS NULL"#,
    &[account],
  )
  .await
}

/// Creates a group, with the caller as its first member, and its general.
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
  sqlx::query(r#"INSERT INTO group_member ("group", account) VALUES (?, ?)"#)
    .bind(&group.id)
    .bind(&caller.account)
    .execute(&mut *tx)
    .await?;
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
    Json(group_json(&mut db, &group).await?),
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
  let group = group_for(&mut db, &id, &caller.account).await?;
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
    group_json(&mut db, &GroupRow { name, ..group }).await?,
  ))
}

/// Deletes a group, with its projects and their sessions; one's own group stays.
pub async fn delete(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  caller.as_person()?;
  let mut db = app.db.acquire().await?;
  let group = group_for(&mut db, &id, &caller.account).await?;
  if group.person.is_some() {
    return Err(Refusal::forbidden(
      "Your own group stays as long as you do.",
    ));
  }
  let others: Vec<String> =
    sqlx::query_scalar(r#"SELECT account FROM group_member WHERE "group" = ? AND account != ?"#)
      .bind(&group.id)
      .bind(&caller.account)
      .fetch_all(&mut *db)
      .await?;
  sqlx::query(r#"DELETE FROM "group" WHERE id = ?"#)
    .bind(&group.id)
    .execute(&mut *db)
    .await?;
  for other in others {
    let own = own_group_of(&mut db, &other).await?;
    let inbox = general_of(&mut db, &own).await?;
    let text = format!(
      "{} deleted the group {}.",
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

/// Adds a friend of the caller to a group; one's own group holds them alone.
pub async fn add_member(
  State(app): State<App>,
  caller: Caller,
  Path((id, name)): Path<(String, String)>,
) -> Result<Json<Group>> {
  caller.as_person()?;
  let mut db = app.db.acquire().await?;
  caller.limit(&mut db, "add_group_member").await?;
  let group = group_for(&mut db, &id, &caller.account).await?;
  if group.person.is_some() {
    return Err(Refusal::forbidden("Your own group holds you alone."));
  }
  let Some((person, login)) = person_by_login(&mut db, &name).await? else {
    return Err(Refusal::not_found(
      "No such person on Vibe Together: an invite to the group (create_invite with group) reaches someone new.",
    ));
  };
  if is_member(&mut db, &group.id, &person).await? {
    return Ok(Json(group_json(&mut db, &group).await?));
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
  if db::count(
    &mut db,
    r#"SELECT count(*) FROM group_member WHERE "group" = ?"#,
    &[&group.id],
  )
  .await?
    >= MAX_MEMBERS
  {
    return Err(Refusal::forbidden(format!(
      "A group has at most {MAX_MEMBERS} members."
    )));
  }
  sqlx::query(r#"INSERT INTO group_member ("group", account) VALUES (?, ?)"#)
    .bind(&group.id)
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
  Ok(Json(group_json(&mut db, &group).await?))
}

/// Removes a member, the caller included, as one leaves; the last member leaves only by deleting
/// the group.
pub async fn remove_member(
  State(app): State<App>,
  caller: Caller,
  Path((id, name)): Path<(String, String)>,
) -> Result<StatusCode> {
  caller.as_person()?;
  let mut db = app.db.acquire().await?;
  let group = group_for(&mut db, &id, &caller.account).await?;
  if group.person.is_some() {
    return Err(Refusal::forbidden("Your own group holds you alone."));
  }
  let Some((person, login)) = person_by_login(&mut db, &name).await? else {
    return Err(Refusal::not_found("No such member."));
  };
  if !is_member(&mut db, &group.id, &person).await? {
    return Err(Refusal::not_found("No such member."));
  }
  if db::count(
    &mut db,
    r#"SELECT count(*) FROM group_member WHERE "group" = ?"#,
    &[&group.id],
  )
  .await?
    == 1
  {
    return Err(Refusal::conflict(
      "This is the group's last member: delete the group instead, which deletes its projects and sessions.",
    ));
  }
  sqlx::query(r#"DELETE FROM group_member WHERE "group" = ? AND account = ?"#)
    .bind(&group.id)
    .bind(&person)
    .execute(&mut *db)
    .await?;
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

async fn project_for(db: &mut Db, id: &str, account: &str) -> Result<ProjectRow> {
  let project: Option<ProjectRow> =
    sqlx::query_as(r#"SELECT id, name, "group" FROM project WHERE id = ?"#)
      .bind(id)
      .fetch_optional(&mut *db)
      .await?;
  match project {
    Some(project) if is_member(db, &project.group, account).await? => Ok(project),
    _ => Err(Refusal::not_found("No such project.")),
  }
}

pub async fn projects_of(db: &mut Db, account: &str) -> Result<Vec<ProjectRow>> {
  Ok(
    sqlx::query_as(
      r#"SELECT p.id, p.name, p."group" FROM project p JOIN group_member m ON m."group" = p."group"
         WHERE m.account = ? ORDER BY p.created"#,
    )
    .bind(account)
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
  for project in projects_of(&mut db, &caller.account).await? {
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
  let group = group_for(&mut db, &group, &caller.account).await?;
  if db::count(
    &mut db,
    r#"SELECT count(*) FROM project WHERE "group" = ?"#,
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
  let project = project_for(&mut db, &id, &caller.account).await?;
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

/// Deletes a project, with its sessions.
pub async fn delete_project(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  caller.as_person()?;
  let mut db = app.db.acquire().await?;
  let project = project_for(&mut db, &id, &caller.account).await?;
  sqlx::query("DELETE FROM project WHERE id = ?")
    .bind(&project.id)
    .execute(&mut *db)
    .await?;
  let general = general_of(&mut db, &project.group).await?;
  let text = format!(
    "{} deleted the project {}, with its sessions.",
    caller.actor(),
    quoted(&project.name)
  );
  transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
  caller
    .record(&mut db, "delete_project", json!({ "id": id }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}
