//! Friends, by mutual agreement, and the DM every two friends have.

use axum::{Json, extract::State, http::StatusCode};
use serde_json::json;
use vibetogether_protocol::{Friend, FriendState, Session};

use crate::{
  App,
  caller::Caller,
  db::{self, Db, are_friends, dm_of, general_of, own_group_of},
  error::{Refusal, Result},
  extract::Path,
  sessions::session_json,
  transport,
};

#[derive(sqlx::FromRow)]
struct FriendRow {
  login: String,
  display_name: String,
  image: Option<String>,
  added: bool,
  added_by: bool,
}

/// The caller's friends, and who asked whom.
pub async fn friends_of(db: &mut Db, me: &str) -> Result<Vec<Friend>> {
  let rows: Vec<FriendRow> = sqlx::query_as(
    r#"SELECT a.login, a.display_name, a.image, mine."from" IS NOT NULL AS added,
       theirs."from" IS NOT NULL AS added_by FROM account a
       LEFT JOIN friend mine ON mine."from" = ?1 AND mine."to" = a.id
       LEFT JOIN friend theirs ON theirs."from" = a.id AND theirs."to" = ?1
       WHERE mine."from" IS NOT NULL OR theirs."from" IS NOT NULL ORDER BY a.login"#,
  )
  .bind(me)
  .fetch_all(db)
  .await?;
  Ok(
    rows
      .into_iter()
      .map(|row| Friend {
        state: match (row.added, row.added_by) {
          (true, true) => FriendState::Friends,
          (true, false) => FriendState::Asked,
          _ => FriendState::Asking,
        },
        name: row.login,
        display_name: row.display_name,
        image: row.image,
      })
      .collect(),
  )
}

/// The DMs of `me`, one with each friend, while they are friends.
pub async fn dms_of(db: &mut Db, me: &str) -> Result<Vec<Session>> {
  let friends: Vec<String> = sqlx::query_scalar(
    r#"SELECT f."to" FROM friend f JOIN friend r ON r."from" = f."to" AND r."to" = f."from"
       JOIN account a ON a.id = f."to" WHERE f."from" = ? ORDER BY a.login"#,
  )
  .bind(me)
  .fetch_all(&mut *db)
  .await?;
  let mut dms = Vec::new();
  for friend in friends {
    let dm = dm_of(db, me, &friend).await?;
    dms.push(session_json(db, &dm, me).await?);
  }
  Ok(dms)
}

async fn person(db: &mut Db, login: &str) -> Result<Option<String>> {
  Ok(
    sqlx::query_scalar("SELECT id FROM account WHERE login = ?")
      .bind(login)
      .fetch_optional(db)
      .await?,
  )
}

pub async fn list(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Friend>>> {
  let mut db = app.db.acquire().await?;
  Ok(Json(friends_of(&mut db, &caller.account).await?))
}

/// Adds a person as a friend, which accepts where they asked first: the person's alone, never an
/// agent's.
pub async fn add(
  State(app): State<App>,
  caller: Caller,
  Path(name): Path<String>,
) -> Result<StatusCode> {
  caller.as_person()?;
  let mut db = app.db.acquire().await?;
  caller.limit(&mut db, "add_friend").await?;
  let me = &caller.account;
  let Some(other) = person(&mut db, &name).await? else {
    return Err(Refusal::not_found(
      "No such person on Vibe Together: an invite (create_invite) reaches someone new.",
    ));
  };
  if other == *me {
    return Err(Refusal::bad("You can't add yourself as a friend."));
  }
  let added =
    sqlx::query(r#"INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)"#)
      .bind(me)
      .bind(&other)
      .bind(db::now())
      .execute(&mut *db)
      .await?
      .rows_affected()
      > 0;
  let friends = are_friends(&mut db, me, &other).await?;
  if friends {
    dm_of(&mut db, me, &other).await?;
  }
  if added && (friends || app.limits.first_ask(me, &other)) {
    let own = own_group_of(&mut db, &other).await?;
    let inbox = general_of(&mut db, &own).await?;
    let text = match friends {
      true => format!(
        "{} accepted your friend request: you have a DM now.",
        caller.person
      ),
      false => format!(
        "{} asked to be your friend: to accept, add them back on the website, or with a person token.",
        caller.person
      ),
    };
    transport::announce(&app, &mut db, &inbox, &text, &[], &[]).await?;
  }
  caller
    .record(&mut db, "add_friend", json!({ "name": name }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

/// Removes a friend, which also declines or withdraws an ask. Their DM closes, and comes back
/// with its history once they are friends again.
pub async fn remove(
  State(app): State<App>,
  caller: Caller,
  Path(name): Path<String>,
) -> Result<StatusCode> {
  let mut db = app.db.acquire().await?;
  let other = person(&mut db, &name)
    .await?
    .ok_or_else(|| Refusal::not_found("No such person."))?;
  sqlx::query(
    r#"DELETE FROM friend WHERE ("from" = ?1 AND "to" = ?2) OR ("from" = ?2 AND "to" = ?1)"#,
  )
  .bind(&caller.account)
  .bind(&other)
  .execute(&mut *db)
  .await?;
  caller
    .record(&mut db, "remove_friend", json!({ "name": name }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

/// The caller's DMs, one session with each friend; an agent sees none, since a DM holds its two
/// people alone.
pub async fn dms(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Session>>> {
  if caller.agent.is_some() {
    return Ok(Json(Vec::new()));
  }
  let mut db = app.db.acquire().await?;
  Ok(Json(dms_of(&mut db, &caller.account).await?))
}
