//! The database, and what the parts share of it: ids, times, and who sees what.

use std::{path::Path, str::FromStr, time::Duration};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jiff::{SignedDuration, Timestamp};
use rand::RngExt;
use sqlx::{
  SqliteConnection, SqlitePool,
  sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

use crate::error::Result;

/// A connection, or a transaction on one, which every query takes.
pub type Db = SqliteConnection;

/// Opens the database, made and migrated where needed, with the TypeScript backend's accounts
/// and tokens imported where its database is still there (`legacy`).
///
/// It is one connection, so every query runs after the one before, as in one thread: whoever
/// holds it must never wait for it again, so every function that queries takes the `Db` its
/// caller holds.
pub async fn open(path: &Path) -> Result<SqlitePool, String> {
  let legacy = crate::legacy::set_aside(path).await?;
  let options = SqliteConnectOptions::from_str("sqlite:")
    .map_err(|e| e.to_string())?
    .filename(path)
    .create_if_missing(true)
    .journal_mode(SqliteJournalMode::Wal)
    .foreign_keys(true)
    .busy_timeout(Duration::from_secs(5));
  let db = SqlitePoolOptions::new()
    .max_connections(1)
    .acquire_timeout(Duration::from_secs(60))
    .connect_with(options)
    .await
    .map_err(|e| format!("{}: {e}", path.display()))?;
  sqlx::migrate!()
    .run(&db)
    .await
    .map_err(|e| format!("migrating {}: {e}", path.display()))?;
  if let Some(legacy) = legacy {
    crate::legacy::import(&db, &legacy).await?;
  }
  Ok(db)
}

/// A new id, such as `s_…` for a session: 12 random bytes, hard to guess.
pub fn new_id(prefix: &str) -> String {
  format!(
    "{prefix}_{}",
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 12]>())
  )
}

/// A random code of `length` characters from `alphabet`.
pub fn random_code(alphabet: &str, length: usize) -> String {
  let chars: Vec<char> = alphabet.chars().collect();
  let mut rng = rand::rng();
  (0..length)
    .map(|_| chars[rng.random_range(0..chars.len())])
    .collect()
}

/// A time as the database keeps it: ISO 8601 in UTC with milliseconds, which compares as text.
pub fn iso(time: Timestamp) -> String {
  time.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn now() -> String {
  iso(Timestamp::now())
}

/// The time `seconds` from now, or before it where negative.
pub fn from_now(seconds: i64) -> String {
  iso(Timestamp::now() + SignedDuration::from_secs(seconds))
}

pub async fn count(db: &mut Db, sql: &'static str, args: &[&str]) -> Result<i64> {
  let mut query = sqlx::query_scalar(sql);
  for arg in args {
    query = query.bind(*arg);
  }
  Ok(query.fetch_one(db).await?)
}

/// The most groups a person is in besides their own, and the most members of a group.
pub const MAX_GROUPS: i64 = 20;
pub const MAX_MEMBERS: i64 = 50;

pub async fn is_member(db: &mut Db, group: &str, account: &str) -> Result<bool> {
  Ok(
    sqlx::query(r#"SELECT 1 FROM group_member WHERE "group" = ? AND account = ?"#)
      .bind(group)
      .bind(account)
      .fetch_optional(db)
      .await?
      .is_some(),
  )
}

/// Whether `a` and `b` are friends: each has added the other.
pub async fn are_friends(db: &mut Db, a: &str, b: &str) -> Result<bool> {
  let n: i64 = sqlx::query_scalar(
    r#"SELECT count(*) FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)"#,
  )
  .bind(a)
  .bind(b)
  .bind(b)
  .bind(a)
  .fetch_one(db)
  .await?;
  Ok(n == 2)
}

/// The group's own session `general`, made where it doesn't exist yet.
pub async fn general_of(db: &mut Db, group: &str) -> Result<String> {
  let existing: Option<String> =
    sqlx::query_scalar(r#"SELECT session FROM group_session WHERE "group" = ? AND general = 1"#)
      .bind(group)
      .fetch_optional(&mut *db)
      .await?;
  if let Some(session) = existing {
    return Ok(session);
  }
  let session = new_id("s");
  sqlx::query("INSERT INTO session (id, name, created) VALUES (?, 'general', ?)")
    .bind(&session)
    .bind(now())
    .execute(&mut *db)
    .await?;
  sqlx::query(r#"INSERT INTO group_session (session, "group", general) VALUES (?, ?, 1)"#)
    .bind(&session)
    .bind(group)
    .execute(db)
    .await?;
  Ok(session)
}

/// The session of the DM of `x` and `y`, made where it doesn't exist yet.
pub async fn dm_of(db: &mut Db, x: &str, y: &str) -> Result<String> {
  let (a, b) = if x < y { (x, y) } else { (y, x) };
  let existing: Option<String> = sqlx::query_scalar("SELECT session FROM dm WHERE a = ? AND b = ?")
    .bind(a)
    .bind(b)
    .fetch_optional(&mut *db)
    .await?;
  if let Some(session) = existing {
    return Ok(session);
  }
  let session = new_id("s");
  sqlx::query("INSERT INTO session (id, name, created) VALUES (?, 'DM', ?)")
    .bind(&session)
    .bind(now())
    .execute(&mut *db)
    .await?;
  sqlx::query("INSERT INTO dm (a, b, session) VALUES (?, ?, ?)")
    .bind(a)
    .bind(b)
    .bind(&session)
    .execute(db)
    .await?;
  Ok(session)
}

/// The person's own group, made with their account.
pub async fn own_group_of(db: &mut Db, account: &str) -> Result<String> {
  Ok(
    sqlx::query_scalar(r#"SELECT id FROM "group" WHERE person = ?"#)
      .bind(account)
      .fetch_one(db)
      .await?,
  )
}

/// A session as access to it is decided: its group, its project's or its own, or its DM's two
/// people.
#[derive(sqlx::FromRow, Clone, Debug)]
pub struct SessionAccess {
  pub id: String,
  pub name: String,
  pub project: Option<String>,
  pub group: Option<String>,
  pub general: bool,
  pub a: Option<String>,
  pub b: Option<String>,
}

/// The session, where `account` takes part in it: a member of its group, or one of its DM's two
/// friends.
pub async fn session_for(db: &mut Db, id: &str, account: &str) -> Result<Option<SessionAccess>> {
  let session: Option<SessionAccess> = sqlx::query_as(
    r#"SELECT s.id, s.name, s.project, coalesce(p."group", gs."group") AS "group",
       coalesce(gs.general, 0) AS general, d.a, d.b FROM session s
       LEFT JOIN project p ON p.id = s.project LEFT JOIN group_session gs ON gs.session = s.id
       LEFT JOIN dm d ON d.session = s.id WHERE s.id = ?"#,
  )
  .bind(id)
  .fetch_optional(&mut *db)
  .await?;
  let Some(session) = session else {
    return Ok(None);
  };
  let sees = match (&session.group, &session.a, &session.b) {
    (Some(group), _, _) => is_member(db, group, account).await?,
    (None, Some(a), Some(b)) => (a == account || b == account) && are_friends(db, a, b).await?,
    _ => false,
  };
  Ok(sees.then_some(session))
}
