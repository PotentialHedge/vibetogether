//! The one-time import from the TypeScript backend's database, which was Better Auth's and
//! Vibe Together's tables in the same file. Its accounts come over, each signed up with GitHub,
//! and its machines' tokens, as agent tokens; browsers sign in again, and Vibe Together's own
//! state starts empty.
//!
//! At start, a database of the old schema is set aside as `<name>-legacy.db`, a new one takes its
//! place, and the import runs from it in one transaction. Once it is done, every secret is wiped
//! from the file, and it is renamed to `<name>-legacy-imported.db`, so that the import runs once,
//! and a crash before then runs it again, adding nothing twice.

use std::path::{Path, PathBuf};

use jiff::Timestamp;
use sqlx::{Connection, SqliteConnection, SqlitePool, sqlite::SqliteConnectOptions};

use vibetogether_protocol::SYSTEM_NAME;

use crate::{auth, db};

fn sibling(path: &Path, suffix: &str) -> PathBuf {
  let stem = path.file_stem().unwrap_or_default().to_string_lossy();
  path.with_file_name(format!("{stem}{suffix}.db"))
}

/// Sets the database at `path` aside where it is of the old schema, and returns the database to
/// import from, if any.
pub async fn set_aside(path: &Path) -> Result<Option<PathBuf>, String> {
  let legacy = sibling(path, "-legacy");
  if path.exists() && is_legacy(path).await.map_err(|e| e.to_string())? {
    if legacy.exists() {
      return Err(format!(
        "{} is of the old schema, but {} is there already",
        path.display(),
        legacy.display()
      ));
    }
    std::fs::rename(path, &legacy).map_err(|e| e.to_string())?;
    tracing::info!("set {} aside as {}", path.display(), legacy.display());
  }
  Ok(legacy.exists().then_some(legacy))
}

/// Whether the database is the TypeScript backend's: Better Auth's `user` and no migrations.
/// Its WAL is folded into the file, so that the file alone holds it.
async fn is_legacy(path: &Path) -> Result<bool, sqlx::Error> {
  let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path)).await?;
  let tables: Vec<String> =
    sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
      .fetch_all(&mut db)
      .await?;
  let legacy =
    tables.iter().any(|t| t == "user") && !tables.iter().any(|t| t == "_sqlx_migrations");
  if legacy {
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
      .execute(&mut db)
      .await?;
  }
  db.close().await?;
  Ok(legacy)
}

/// A time as Better Auth kept it, ISO 8601 or milliseconds since the epoch, as the database
/// keeps it now.
fn time_of(given: &str) -> String {
  match given.parse::<i64>() {
    Ok(ms) => Timestamp::from_millisecond(ms)
      .map(db::iso)
      .unwrap_or_else(|_| db::now()),
    Err(_) => given
      .parse::<Timestamp>()
      .map(db::iso)
      .unwrap_or_else(|_| db::now()),
  }
}

/// Imports the accounts and the machines' tokens from `legacy`, then marks it imported.
pub async fn import(pool: &SqlitePool, legacy: &Path) -> Result<(), String> {
  let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
  sqlx::query("ATTACH DATABASE ? AS legacy")
    .bind(legacy.to_string_lossy())
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
  let imported = copy(&mut conn).await;
  sqlx::query("DETACH DATABASE legacy")
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
  let (accounts, tokens) = imported.map_err(|e| format!("importing {}: {e}", legacy.display()))?;
  scrub(legacy)
    .await
    .map_err(|e| format!("wiping the secrets of {}: {e}", legacy.display()))?;
  let done = sibling(legacy, "-imported");
  std::fs::rename(legacy, &done).map_err(|e| e.to_string())?;
  tracing::info!(
    "imported {accounts} accounts and {tokens} tokens from {}, now {}",
    legacy.display(),
    done.display()
  );
  Ok(())
}

/// What holds a secret in the old schema: its tokens, codes and keys, each wiped where its
/// table is there.
const SECRETS: [(&str, &str); 9] = [
  ("login", "DELETE FROM login"),
  ("verification", "DELETE FROM verification"),
  ("deviceCode", r#"DELETE FROM "deviceCode""#),
  ("oauthAccessToken", r#"DELETE FROM "oauthAccessToken""#),
  ("oauthRefreshToken", r#"DELETE FROM "oauthRefreshToken""#),
  ("otp_request", "DELETE FROM otp_request"),
  ("invite", "DELETE FROM invite"),
  (
    "account",
    r#"UPDATE account SET "accessToken" = NULL, "refreshToken" = NULL, "idToken" = NULL, password = NULL"#,
  ),
  (
    "oauthClient",
    r#"UPDATE "oauthClient" SET "clientSecret" = NULL"#,
  ),
];

/// Wipes every secret from the imported database, so that the file kept holds none: no row or
/// value of `SECRETS`, nor any page they were on, which `VACUUM` rewrites.
async fn scrub(legacy: &Path) -> Result<(), sqlx::Error> {
  let mut db =
    SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(legacy)).await?;
  let tables: Vec<String> =
    sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
      .fetch_all(&mut db)
      .await?;
  for (table, wipe) in SECRETS {
    if tables.iter().any(|t| t == table) {
      sqlx::query(wipe).execute(&mut db).await?;
    }
  }
  sqlx::query("VACUUM").execute(&mut db).await?;
  sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
    .execute(&mut db)
    .await?;
  db.close().await
}

#[derive(sqlx::FromRow)]
struct LegacyAccount {
  user: String,
  github: String,
  login: String,
  name: String,
  image: Option<String>,
}

#[derive(sqlx::FromRow)]
struct LegacyToken {
  machine: String,
  token: String,
  created: String,
}

async fn copy(conn: &mut SqliteConnection) -> Result<(usize, usize), String> {
  let fail = |e: crate::error::Refusal| e.message;
  let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
  let people: Vec<LegacyAccount> = sqlx::query_as(
    "SELECT u.id AS user, a.accountId AS github, u.login, u.name, u.image FROM legacy.user u
     JOIN legacy.account a ON a.userId = u.id AND a.providerId = 'github'",
  )
  .fetch_all(&mut *tx)
  .await
  .map_err(|e| e.to_string())?;
  let (mut accounts, mut tokens) = (0, 0);
  for person in people {
    let Ok(github) = person.github.parse::<i64>() else {
      continue;
    };
    if person.login.eq_ignore_ascii_case(SYSTEM_NAME) {
      tracing::warn!(
        "skipped the account named {SYSTEM_NAME}, the name system messages are sent under"
      );
      continue;
    }
    let account = auth::account_of(
      &mut tx,
      github,
      &person.login,
      &person.name,
      person.image.as_deref(),
    )
    .await
    .map_err(fail)?;
    accounts += 1;
    let machines: Vec<LegacyToken> = sqlx::query_as(
      "SELECT machine, token, CAST(createdAt AS TEXT) AS created FROM legacy.login
       WHERE userId = ? AND machine IS NOT NULL AND CAST(expiresAt AS TEXT) > ?",
    )
    .bind(&person.user)
    .bind(db::now())
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    for machine in machines {
      let added = sqlx::query(
        "INSERT OR IGNORE INTO login (id, account, kind, name, token, created)
         VALUES (?, ?, 'agent', ?, ?, ?)",
      )
      .bind(db::new_id("l"))
      .bind(&account)
      .bind(&machine.machine)
      .bind(auth::token_hash(&machine.token))
      .bind(time_of(&machine.created))
      .execute(&mut *tx)
      .await
      .map_err(|e| e.to_string())?;
      tokens += added.rows_affected() as usize;
    }
  }
  tx.commit().await.map_err(|e| e.to_string())?;
  Ok((accounts, tokens))
}
