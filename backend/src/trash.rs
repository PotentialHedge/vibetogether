//! The trash: what is deleted, a group, project or session, or an archived agent, stays in it,
//! shown to no one but in it, until it is restored or purged, `TRASH_DAYS` after it was deleted.
//! Agents delete too, Luis's decision (2026-11-19), so the trash is what makes a hijacked agent's
//! deleting undone.
//!
//! A deleted thing keeps everything in it as it was, its log, its participants and its members,
//! and is hidden where access is decided: `db::is_member` for a group, `db::session_for` for a
//! session, and every list. Whoever could delete it restores it: for a group, its members; for a
//! project or session, the members of its group, while the group and project it is in are not in
//! the trash themselves; for an agent, its person and their agents.

use axum::{Json, extract::State, http::StatusCode};
use jiff::{SignedDuration, Timestamp};
use serde_json::json;
use vibetogether_protocol::{Named, TrashKind, Trashed};

use crate::{
  App,
  caller::Caller,
  db::{self, Db, TRASH_DAYS, general_of, is_member, own_group_of},
  error::{Refusal, Result},
  extract::Path,
  transport::{self, quoted},
};

/// Puts a group, project or session in the trash, by `caller`. `table` is its table's name,
/// never a request's.
pub async fn put(db: &mut Db, table: &'static str, id: &str, caller: &Caller) -> Result<()> {
  sqlx::query(sqlx::AssertSqlSafe(format!(
    r#"UPDATE "{table}" SET trashed = ?, trashed_by = ? WHERE id = ? AND trashed IS NULL"#
  )))
  .bind(db::now())
  .bind(caller.actor())
  .bind(id)
  .execute(db)
  .await?;
  Ok(())
}

/// When something deleted at `trashed` is purged.
fn purged_at(trashed: &str) -> String {
  trashed
    .parse::<Timestamp>()
    .map(|t| db::iso(t + SignedDuration::from_hours(TRASH_DAYS * 24)))
    .unwrap_or_default()
}

#[derive(sqlx::FromRow)]
struct Row {
  id: String,
  name: String,
  trashed: String,
  by: Option<String>,
  group_id: Option<String>,
  group_name: Option<String>,
  project_id: Option<String>,
  project_name: Option<String>,
}

fn named(id: Option<String>, name: Option<String>) -> Option<Named> {
  Some(Named {
    id: id?,
    name: name?,
  })
}

fn trashed(kind: TrashKind, row: Row) -> Trashed {
  Trashed {
    purged: purged_at(&row.trashed),
    id: row.id,
    kind,
    name: row.name,
    group: named(row.group_id, row.group_name),
    project: named(row.project_id, row.project_name),
    trashed: row.trashed,
    by: row.by,
  }
}

/// The groups in the trash that `who` is a member of.
async fn groups(db: &mut Db, who: &str, only: Option<&str>) -> Result<Vec<Row>> {
  Ok(
    sqlx::query_as(
      r#"SELECT g.id, g.name, g.trashed, g.trashed_by AS by, NULL AS group_id, NULL AS group_name,
         NULL AS project_id, NULL AS project_name
         FROM "group" g JOIN group_member m ON m."group" = g.id
         WHERE m.member = ?1 AND g.trashed IS NOT NULL AND (?2 IS NULL OR g.id = ?2)"#,
    )
    .bind(who)
    .bind(only)
    .fetch_all(db)
    .await?,
  )
}

/// The projects in the trash of the groups `who` is in, the groups not in it.
async fn projects(db: &mut Db, who: &str, only: Option<&str>) -> Result<Vec<Row>> {
  Ok(
    sqlx::query_as(
      r#"SELECT p.id, p.name, p.trashed, p.trashed_by AS by, g.id AS group_id, g.name AS group_name,
         NULL AS project_id, NULL AS project_name
         FROM project p JOIN "group" g ON g.id = p."group" JOIN group_member m ON m."group" = g.id
         WHERE m.member = ?1 AND p.trashed IS NOT NULL AND g.trashed IS NULL
         AND (?2 IS NULL OR p.id = ?2)"#,
    )
    .bind(who)
    .bind(only)
    .fetch_all(db)
    .await?,
  )
}

/// The sessions in the trash of the groups `who` is in, neither the group nor the project not in
/// it.
async fn sessions(db: &mut Db, who: &str, only: Option<&str>) -> Result<Vec<Row>> {
  Ok(
    sqlx::query_as(
      r#"SELECT s.id, s.name, s.trashed, s.trashed_by AS by, g.id AS group_id, g.name AS group_name,
         p.id AS project_id, p.name AS project_name
         FROM session s LEFT JOIN project p ON p.id = s.project
         LEFT JOIN group_session gs ON gs.session = s.id
         JOIN "group" g ON g.id = coalesce(p."group", gs."group")
         JOIN group_member m ON m."group" = g.id
         WHERE m.member = ?1 AND s.trashed IS NOT NULL AND p.trashed IS NULL AND g.trashed IS NULL
         AND (?2 IS NULL OR s.id = ?2)"#,
    )
    .bind(who)
    .bind(only)
    .fetch_all(db)
    .await?,
  )
}

/// The archived agents of the account.
async fn agents(db: &mut Db, account: &str, only: Option<&str>) -> Result<Vec<Row>> {
  Ok(
    sqlx::query_as(
      r#"SELECT ag.id, a.login || '/' || ag.name AS name, ag.archived AS trashed,
         ag.archived_by AS by, NULL AS group_id, NULL AS group_name, NULL AS project_id,
         NULL AS project_name
         FROM agent ag JOIN account a ON a.id = ag.account
         WHERE ag.account = ?1 AND ag.archived IS NOT NULL AND (?2 IS NULL OR ag.id = ?2)"#,
    )
    .bind(account)
    .bind(only)
    .fetch_all(db)
    .await?,
  )
}

/// What is in the trash that the caller restores, newest first.
pub async fn list(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Trashed>>> {
  let mut db = app.db.acquire().await?;
  let who = caller.who();
  let mut all = Vec::new();
  for (kind, rows) in [
    (TrashKind::Group, groups(&mut db, who, None).await?),
    (TrashKind::Project, projects(&mut db, who, None).await?),
    (TrashKind::Session, sessions(&mut db, who, None).await?),
    (
      TrashKind::Agent,
      agents(&mut db, &caller.account, None).await?,
    ),
  ] {
    all.extend(rows.into_iter().map(|row| trashed(kind, row)));
  }
  all.sort_by(|a, b| b.trashed.cmp(&a.trashed));
  Ok(Json(all))
}

/// Restores something from the trash, by its id: it shows again where it was, with everything
/// in it. An agent comes back in its person's own group, held by the login that held it.
pub async fn restore(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  let mut db = app.db.acquire().await?;
  let who = caller.who().to_string();
  let missing = || Refusal::not_found("Nothing of this id in your trash.");
  let (kind, row) = match id.split_once('_').map(|(prefix, _)| prefix) {
    Some("g") => (TrashKind::Group, groups(&mut db, &who, Some(&id)).await?),
    Some("p") => (
      TrashKind::Project,
      projects(&mut db, &who, Some(&id)).await?,
    ),
    Some("s") => (
      TrashKind::Session,
      sessions(&mut db, &who, Some(&id)).await?,
    ),
    Some("a") => (
      TrashKind::Agent,
      agents(&mut db, &caller.account, Some(&id)).await?,
    ),
    _ => return Err(missing()),
  };
  let row = row.into_iter().next().ok_or_else(missing)?;
  let table = match kind {
    TrashKind::Group => "group",
    TrashKind::Project => "project",
    TrashKind::Session => "session",
    TrashKind::Agent => {
      let restored = sqlx::query(
        "UPDATE agent SET archived = NULL, archived_by = NULL WHERE id = ? AND account = ?",
      )
      .bind(&row.id)
      .bind(&caller.account)
      .execute(&mut *db)
      .await;
      match restored {
        Err(e) if crate::error::is_taken(&e) => {
          return Err(Refusal::conflict(
            "Another agent of this account has this agent's name now: rename that one first.",
          ));
        }
        other => other?,
      };
      caller
        .record(&mut db, "restore", json!({ "id": id }))
        .await?;
      return Ok(StatusCode::NO_CONTENT);
    }
  };
  sqlx::query(sqlx::AssertSqlSafe(format!(
    r#"UPDATE "{table}" SET trashed = NULL, trashed_by = NULL WHERE id = ?"#
  )))
  .bind(&row.id)
  .execute(&mut *db)
  .await?;
  let what = match kind {
    TrashKind::Group => "group",
    TrashKind::Project => "project",
    _ => "session",
  };
  let text = format!(
    "{} restored the {what} {} from the trash.",
    caller.actor(),
    quoted(&row.name)
  );
  match (kind, &row.group_id) {
    (TrashKind::Group, _) => {
      let people: Vec<String> = sqlx::query_scalar(
        r#"SELECT member FROM group_member WHERE "group" = ? AND member = account"#,
      )
      .bind(&row.id)
      .fetch_all(&mut *db)
      .await?;
      for person in people {
        let own = own_group_of(&mut db, &person).await?;
        let inbox = general_of(&mut db, &own).await?;
        transport::announce(&app, &mut db, &inbox, &text, &[], &[]).await?;
      }
    }
    (_, Some(group)) if is_member(&mut db, group, &who).await? => {
      let general = general_of(&mut db, group).await?;
      transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
    }
    _ => {}
  }
  caller
    .record(&mut db, "restore", json!({ "id": id }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

/// Purges what has been in the trash for `TRASH_DAYS`, with everything in it: a group, project or
/// session for good, and an agent's row, which frees its place among the account's agents.
pub async fn purge(db: &mut Db) -> Result<()> {
  let before = db::from_now(-TRASH_DAYS * 86400);
  for table in ["group", "project", "session"] {
    sqlx::query(sqlx::AssertSqlSafe(format!(
      r#"DELETE FROM "{table}" WHERE trashed < ?"#
    )))
    .bind(&before)
    .execute(&mut *db)
    .await?;
  }
  let agents: Vec<String> = sqlx::query_scalar("SELECT id FROM agent WHERE archived < ?")
    .bind(&before)
    .fetch_all(&mut *db)
    .await?;
  for agent in agents {
    for sql in [
      "DELETE FROM group_member WHERE member = ?",
      "DELETE FROM participant WHERE id = ?",
      "DELETE FROM agent WHERE id = ?",
    ] {
      sqlx::query(sql).bind(&agent).execute(&mut *db).await?;
    }
  }
  Ok(())
}
