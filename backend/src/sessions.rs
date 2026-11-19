//! Sessions as the account has them, and each session's log, which its participants join, send
//! to, receive from and leave (`transport`).

use std::collections::BTreeMap;

use axum::{
  Json,
  extract::State,
  http::{HeaderMap, HeaderValue, StatusCode, header},
  response::{IntoResponse, Response},
};
use serde_json::json;
use sqlx::Connection;
use vibetogether_protocol::{
  CreateSession, Joined, Left, Log, LogQuery, MAX_PAYLOAD, MAX_WAIT, NameBody, NotifyBody,
  Participant, ReceiveQuery, Received, SendQuery, Sent, Session, SessionProject,
};

use crate::{
  App,
  caller::Caller,
  db::{self, Db, SessionAccess, TRASH_DAYS, general_of, is_member, session_for},
  error::{Refusal, Result},
  extract::{Json as Body, Path, Query},
  groups::{check_name, repos_of},
  transport::{self, Payload, quoted},
  trash,
};

/// The most sessions one project holds, and one group of its own, besides its general.
pub const MAX_SESSIONS: i64 = 20;

#[derive(sqlx::FromRow)]
struct SessionRow {
  id: String,
  name: String,
  project: Option<String>,
  project_name: Option<String>,
  group_id: Option<String>,
  group_name: Option<String>,
  group_person: Option<String>,
  general: Option<bool>,
  creator: Option<String>,
  a: Option<String>,
  b: Option<String>,
}

/// A session as `me` sees it.
pub async fn session_json(db: &mut Db, id: &str, me: &str) -> Result<Session> {
  let row: SessionRow = sqlx::query_as(
    r#"SELECT s.id, s.name, s.project, p.name AS project_name, g.id AS group_id,
       g.name AS group_name, g.person AS group_person, gs.general, c.login AS creator, d.a, d.b
       FROM session s LEFT JOIN project p ON p.id = s.project
       LEFT JOIN group_session gs ON gs.session = s.id
       LEFT JOIN "group" g ON g.id = coalesce(p."group", gs."group")
       LEFT JOIN account c ON c.id = s.creator LEFT JOIN dm d ON d.session = s.id
       WHERE s.id = ?"#,
  )
  .bind(id)
  .fetch_one(&mut *db)
  .await?;
  let other = if row.a.as_deref() == Some(me) {
    &row.b
  } else {
    &row.a
  };
  let friend = match other {
    Some(other) => Some(
      sqlx::query_scalar("SELECT login FROM account WHERE id = ?")
        .bind(other)
        .fetch_one(&mut *db)
        .await?,
    ),
    None => None,
  };
  let project = match (row.project, row.project_name) {
    (Some(id), Some(name)) => Some(SessionProject {
      repos: repos_of(db, &id).await?,
      id,
      name,
    }),
    _ => None,
  };
  // The person's stream holds its unread items alone.
  let pinged = sqlx::query(
    "SELECT 1 FROM stream WHERE participant = ? AND session = ? AND reach = 'ping' LIMIT 1",
  )
  .bind(me)
  .bind(id)
  .fetch_optional(&mut *db)
  .await?
  .is_some();
  Ok(Session {
    id: row.id,
    name: row.name,
    project,
    group: match (row.group_id, row.group_name) {
      (Some(id), Some(name)) => Some(vibetogether_protocol::Named { id, name }),
      _ => None,
    },
    pinged,
    general: row.general.unwrap_or(false),
    own: row.group_person.as_deref() == Some(me),
    friend,
    creator: row.creator,
  })
}

/// The sessions of the groups `who`, a person or an agent, is in, as its person `me` sees them,
/// each group's general first, then oldest first.
pub async fn sessions_of(db: &mut Db, who: &str, me: &str) -> Result<Vec<Session>> {
  let ids: Vec<String> = sqlx::query_scalar(
    r#"SELECT s.id FROM session s LEFT JOIN project p ON p.id = s.project
       LEFT JOIN group_session gs ON gs.session = s.id
       JOIN group_member m ON m."group" = coalesce(p."group", gs."group")
       JOIN "group" g ON g.id = m."group"
       WHERE m.member = ? AND s.trashed IS NULL AND p.trashed IS NULL AND g.trashed IS NULL
       ORDER BY coalesce(gs.general, 0) DESC, s.created"#,
  )
  .bind(who)
  .fetch_all(&mut *db)
  .await?;
  let mut sessions = Vec::new();
  for id in ids {
    sessions.push(session_json(db, &id, me).await?);
  }
  Ok(sessions)
}

/// The session the caller takes part in. To an agent, the refusal says how it gets into a
/// group, the same whether the session exists or not.
async fn accessible(db: &mut Db, id: &str, caller: &Caller) -> Result<SessionAccess> {
  session_for(db, id, caller.who()).await?.ok_or_else(|| {
    Refusal::not_found(match caller.agent {
      Some(_) => {
        "No such session in your groups: your person lets you into a group (add-member), and a DM holds its two people alone."
      }
      None => "No such session.",
    })
  })
}

/// A session of a group the caller is in: a DM is no group's, so none of these.
async fn of_group(db: &mut Db, id: &str, caller: &Caller) -> Result<SessionAccess> {
  let session = accessible(db, id, caller).await?;
  match session.group {
    Some(_) => Ok(session),
    None => Err(Refusal::not_found("No such session.")),
  }
}

/// Where a session is, for a system message: " in the project `x`", or nothing for a group's own.
async fn where_of(db: &mut Db, session: &SessionAccess) -> Result<String> {
  let Some(project) = &session.project else {
    return Ok(String::new());
  };
  let name: String = sqlx::query_scalar("SELECT name FROM project WHERE id = ?")
    .bind(project)
    .fetch_one(db)
    .await?;
  Ok(format!(" in the project {}", quoted(&name)))
}

fn checked_wait(wait: Option<u64>) -> Result<()> {
  match wait {
    Some(wait) if wait > MAX_WAIT => {
      Err(Refusal::bad(format!("wait: at most {MAX_WAIT} seconds.")))
    }
    _ => Ok(()),
  }
}

/// The sessions of the caller's groups, each group's general first, then oldest first. DMs are
/// `dms`.
pub async fn list(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Session>>> {
  let mut db = app.db.acquire().await?;
  Ok(Json(
    sessions_of(&mut db, caller.who(), &caller.account).await?,
  ))
}

/// Creates a session in a project, or in a group, in no project, for the members of the group
/// and their agents.
pub async fn create(
  State(app): State<App>,
  caller: Caller,
  Body(input): Body<CreateSession>,
) -> Result<(StatusCode, Json<Session>)> {
  let name = check_name(&input.name)?;
  let mut db = app.db.acquire().await?;
  caller.limit(&mut db, "create_session").await?;
  let me = &caller.account;
  let (group, project) = match (&input.project, &input.group) {
    (Some(project), None) => {
      let group: Option<String> =
        sqlx::query_scalar(r#"SELECT "group" FROM project WHERE id = ? AND trashed IS NULL"#)
          .bind(project)
          .fetch_optional(&mut *db)
          .await?;
      match group {
        Some(group) if is_member(&mut db, &group, caller.who()).await? => {
          (group, Some(project.clone()))
        }
        _ => return Err(Refusal::not_found("No such project.")),
      }
    }
    (None, Some(group)) => {
      if !is_member(&mut db, group, caller.who()).await? {
        return Err(Refusal::not_found("No such group."));
      }
      (group.clone(), None)
    }
    _ => return Err(Refusal::bad("Give one of project and group.")),
  };
  let held = match &project {
    Some(project) => {
      db::count(
        &mut db,
        "SELECT count(*) FROM session WHERE project = ? AND trashed IS NULL",
        &[project],
      )
      .await?
    }
    None => {
      db::count(
        &mut db,
        r#"SELECT count(*) FROM group_session gs JOIN session s ON s.id = gs.session
           WHERE gs."group" = ? AND gs.general = 0 AND s.trashed IS NULL"#,
        &[&group],
      )
      .await?
    }
  };
  if held >= MAX_SESSIONS {
    let of = if project.is_some() {
      "project"
    } else {
      "group"
    };
    return Err(Refusal::forbidden(format!(
      "A {of} has at most {MAX_SESSIONS} sessions of its own: delete one first."
    )));
  }
  let id = db::new_id("s");
  let mut tx = db.begin().await?;
  sqlx::query("INSERT INTO session (id, name, project, creator, created) VALUES (?, ?, ?, ?, ?)")
    .bind(&id)
    .bind(&name)
    .bind(&project)
    .bind(me)
    .bind(db::now())
    .execute(&mut *tx)
    .await?;
  if project.is_none() {
    sqlx::query(r#"INSERT INTO group_session (session, "group") VALUES (?, ?)"#)
      .bind(&id)
      .bind(&group)
      .execute(&mut *tx)
      .await?;
  }
  tx.commit().await?;
  let session = accessible(&mut db, &id, &caller).await?;
  let text = format!(
    "{} created the session {}{}.",
    caller.actor(),
    quoted(&name),
    where_of(&mut db, &session).await?
  );
  let general = general_of(&mut db, &group).await?;
  transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
  caller
    .record(
      &mut db,
      "create_session",
      json!({ "name": name, "project": project, "group": input.group }),
    )
    .await?;
  Ok((
    StatusCode::CREATED,
    Json(session_json(&mut db, &id, me).await?),
  ))
}

pub async fn show(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<Json<Session>> {
  let mut db = app.db.acquire().await?;
  let session = accessible(&mut db, &id, &caller).await?;
  Ok(Json(
    session_json(&mut db, &session.id, &caller.account).await?,
  ))
}

/// Renames a session of a group; a DM has no name, and a group's general stays `general`.
pub async fn rename(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
  Body(input): Body<NameBody>,
) -> Result<Json<Session>> {
  let name = check_name(&input.name)?;
  let mut db = app.db.acquire().await?;
  let session = of_group(&mut db, &id, &caller).await?;
  if session.general {
    return Err(Refusal::forbidden("A group's general stays general."));
  }
  sqlx::query("UPDATE session SET name = ? WHERE id = ?")
    .bind(&name)
    .bind(&session.id)
    .execute(&mut *db)
    .await?;
  caller
    .record(&mut db, "rename_session", json!({ "id": id, "name": name }))
    .await?;
  Ok(Json(
    session_json(&mut db, &session.id, &caller.account).await?,
  ))
}

/// Deletes a session of a group with its log, for everyone, into the trash; a DM stays, and a
/// group's general goes only with the group. Any member of its group does it, an agent too.
pub async fn delete(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<StatusCode> {
  let mut db = app.db.acquire().await?;
  let session = of_group(&mut db, &id, &caller).await?;
  if session.general {
    return Err(Refusal::forbidden(
      "A group's general goes only with the group (delete_group).",
    ));
  }
  let place = where_of(&mut db, &session).await?;
  trash::put(&mut db, "session", &session.id, &caller).await?;
  let general = general_of(&mut db, session.group.as_deref().unwrap_or_default()).await?;
  let text = format!(
    "{} deleted the session {}{place}, into the trash, where the group's members restore it within {TRASH_DAYS} days.",
    caller.actor(),
    quoted(&session.name)
  );
  transport::announce(&app, &mut db, &general, &text, &[], &[]).await?;
  caller
    .record(&mut db, "delete_session", json!({ "id": id }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

/// Everyone in the session, with their positions, presence and status. A member sees it without
/// joining.
pub async fn participants(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<Json<BTreeMap<String, Participant>>> {
  let mut db = app.db.acquire().await?;
  let session = accessible(&mut db, &id, &caller).await?;
  Ok(Json(
    transport::participants_of(&app, &mut db, &session.id).await?,
  ))
}

/// Joins a session, or joins again after leaving; joining while in does nothing.
pub async fn join(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<Json<Joined>> {
  let mut db = app.db.acquire().await?;
  let session = accessible(&mut db, &id, &caller).await?;
  let p = transport::acting(&caller);
  let n = transport::join(&app, &mut db, &p, &session.id, &caller.login).await?;
  Ok(Json(Joined {
    n: n as u64,
    name: p.name,
    session: session_json(&mut db, &session.id, &caller.account).await?,
  }))
}

/// Sets what wakes the caller in a session it is in: every message, or only one naming it.
pub async fn notify(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
  Json(body): Json<NotifyBody>,
) -> Result<()> {
  let mut db = app.db.acquire().await?;
  let session = accessible(&mut db, &id, &caller).await?;
  let p = transport::acting(&caller);
  transport::set_notify(&app, &mut db, &p, &session.id, &caller.login, body.notify).await
}

/// Leaves a session; leaving twice does nothing.
pub async fn leave(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
) -> Result<Json<Left>> {
  let mut db = app.db.acquire().await?;
  let session = accessible(&mut db, &id, &caller).await?;
  let p = transport::acting(&caller);
  let n = transport::leave(&app, &mut db, &p, &session.id, &caller.login).await?;
  Ok(Json(Left { n: n as u64 }))
}

/// The most sends of one account at once, each holding its payload in memory.
const MAX_SENDS: usize = 4;

/// Appends an entry with the request's body as its payload, and its `Content-Type` as its type,
/// `text/plain; charset=utf-8` where none is given. The body is read only once the caller is
/// known and has a send of its account's to spare.
pub async fn send(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
  Query(query): Query<SendQuery>,
  headers: HeaderMap,
  body: axum::body::Body,
) -> Result<Json<Sent>> {
  let _sending = app.limits.sends.start(
    &caller.account,
    MAX_SENDS,
    "This account sends too much at once.",
  )?;
  let payload = axum::body::to_bytes(body, MAX_PAYLOAD)
    .await
    .map_err(|_| transport::too_large())?;
  if query.filename.as_ref().is_some_and(|f| f.len() > 256) {
    return Err(Refusal::bad("filename: at most 256 characters."));
  }
  let ty = headers
    .get(header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .filter(|v| !v.trim().is_empty())
    .unwrap_or("text/plain; charset=utf-8");
  let mut db = app.db.acquire().await?;
  let session = accessible(&mut db, &id, &caller).await?;
  let p = transport::acting(&caller);
  let sent = transport::send(
    &app,
    &mut db,
    &p,
    &session.id,
    &caller.login,
    Payload {
      ty,
      bytes: &payload,
      filename: query.filename.as_deref(),
    },
  )
  .await?;
  Ok(Json(sent))
}

/// The payload of entry `n`, with its type and its file name. A payload is anyone's in the
/// session, served from the site's own origin: nothing in it runs here, and only an image shows
/// inline.
pub async fn fetch(
  State(app): State<App>,
  caller: Caller,
  Path((id, n)): Path<(String, u64)>,
) -> Result<Response> {
  let mut db = app.db.acquire().await?;
  let session = accessible(&mut db, &id, &caller).await?;
  let (ty, filename, bytes) = transport::payload_of(&mut db, &session.id, n)
    .await?
    .ok_or_else(|| Refusal::not_found("No such entry."))?;
  let essence = ty
    .split(';')
    .next()
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase();
  let inline = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
  ]
  .contains(&essence.as_str());
  let filename = filename
    .map(|f| format!("; filename*=UTF-8''{}", percent_encoded(&f)))
    .unwrap_or_default();
  let disposition = format!("{}{filename}", if inline { "inline" } else { "attachment" });
  let mut response = bytes.into_response();
  let headers = response.headers_mut();
  let value = |v: &str| {
    HeaderValue::from_str(v).unwrap_or(HeaderValue::from_static("application/octet-stream"))
  };
  headers.insert(header::CONTENT_TYPE, value(&ty));
  headers.insert(header::CONTENT_DISPOSITION, value(&disposition));
  headers.insert(
    header::CONTENT_SECURITY_POLICY,
    HeaderValue::from_static("sandbox; default-src 'none'"),
  );
  headers.insert(
    header::X_CONTENT_TYPE_OPTIONS,
    HeaderValue::from_static("nosniff"),
  );
  Ok(response)
}

/// RFC 3986's percent-encoding of everything but its unreserved characters.
fn percent_encoded(text: &str) -> String {
  text
    .bytes()
    .map(|b| match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
        (b as char).to_string()
      }
      b => format!("%{b:02X}"),
    })
    .collect()
}

/// Observes a session, joined or not, which has no side effects.
pub async fn log(
  State(app): State<App>,
  caller: Caller,
  Path(id): Path<String>,
  Query(query): Query<LogQuery>,
) -> Result<Json<Log>> {
  checked_wait(query.wait)?;
  let session = {
    let mut db = app.db.acquire().await?;
    accessible(&mut db, &id, &caller).await?
  };
  Ok(Json(
    transport::observe(&app, &caller, &session.id, query).await?,
  ))
}

/// A participant receives everything that reaches it, as items of its own stream.
pub async fn receive(
  State(app): State<App>,
  caller: Caller,
  Query(query): Query<ReceiveQuery>,
) -> Result<Json<Received>> {
  checked_wait(query.wait)?;
  let p = transport::acting(&caller);
  Ok(Json(
    transport::receive(&app, &p, &caller.login, query).await?,
  ))
}
