//! Invites: a short link from a person, or their agent, to be their friend, and optionally to
//! join one of their groups. It works once, expires, and its maker revokes it. Accepting it makes
//! the two friends, with their DM, and joins the group, landing in the session it was made from,
//! else the group's general, and without a group their DM.

use axum::{
  Json,
  body::Bytes,
  extract::State,
  http::{HeaderMap, StatusCode},
};
use serde_json::json;
use vibetogether_protocol::{Accepted, CreateInvite, Face, Invite, InviteShown, Named};

use crate::{
  App,
  caller::Caller,
  db::{
    self, Db, MAX_GROUPS, MAX_MEMBERS, are_friends, dm_of, general_of, is_member, own_group_of,
    session_for,
  },
  error::{Refusal, Result},
  extract::Path,
  sessions::session_json,
  transport::{self, quoted},
};

/// How long an invite lasts, in seconds.
const LIFETIME: i64 = 7 * 86400;
/// The most invites one person keeps open at once.
const MAX_OPEN: i64 = 50;
/// Letters and digits that no one misreads for another.
const ALPHABET: &str = "abcdefghjkmnpqrstuvwxyz23456789";

#[derive(sqlx::FromRow)]
struct InviteRow {
  code: String,
  inviter: String,
  created: String,
  expires: String,
  accepted_by: Option<String>,
}

/// The group an invite is to, and the session it was made from, if any.
#[derive(sqlx::FromRow)]
struct Target {
  group: String,
  group_name: String,
  own: bool,
  session: Option<String>,
  session_name: Option<String>,
}

async fn target_of(db: &mut Db, code: &str) -> Result<Option<Target>> {
  Ok(
    sqlx::query_as(
      r#"SELECT g.id AS "group", g.name AS group_name, g.person IS NOT NULL AS own,
         s.id AS session, s.name AS session_name
         FROM invite i JOIN "group" g ON g.id = i."group"
         LEFT JOIN session s ON s.id = i.session AND s.trashed IS NULL
           AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = s.project AND p.trashed IS NOT NULL)
         WHERE i.code = ?"#,
    )
    .bind(code)
    .fetch_optional(db)
    .await?,
  )
}

fn refs_of(target: Option<&Target>) -> (Option<Named>, Option<Named>) {
  let group = target.map(|t| Named {
    id: t.group.clone(),
    name: t.group_name.clone(),
  });
  let session = target.and_then(|t| match (&t.session, &t.session_name) {
    (Some(id), Some(name)) => Some(Named {
      id: id.clone(),
      name: name.clone(),
    }),
    _ => None,
  });
  (group, session)
}

async fn face_of(db: &mut Db, account: &str) -> Result<Face> {
  let (name, display_name, image): (String, String, Option<String>) =
    sqlx::query_as("SELECT login, display_name, image FROM account WHERE id = ?")
      .bind(account)
      .fetch_one(db)
      .await?;
  Ok(Face {
    name,
    display_name,
    image,
  })
}

async fn invite_json(app: &App, db: &mut Db, row: &InviteRow) -> Result<Invite> {
  let (group, session) = refs_of(target_of(db, &row.code).await?.as_ref());
  Ok(Invite {
    code: row.code.clone(),
    link: format!("{}/i/{}", app.config.url, row.code),
    group,
    session,
    created: row.created.clone(),
    expires: row.expires.clone(),
  })
}

async fn invite_by_code(db: &mut Db, code: &str) -> Result<Option<InviteRow>> {
  if code.is_empty() || code.len() > 64 {
    return Ok(None);
  }
  Ok(
    sqlx::query_as(
      "SELECT code, inviter, created, expires, accepted_by FROM invite WHERE code = ?",
    )
    .bind(code.to_lowercase())
    .fetch_optional(db)
    .await?,
  )
}

/// Creates a link that invites one person to be the caller's friend, and with `group` or
/// `session` to join that group too: the person's alone, never an agent's, since accepting it makes
/// a friend.
pub async fn create(
  State(app): State<App>,
  caller: Caller,
  body: Bytes,
) -> Result<(StatusCode, Json<Invite>)> {
  let input: CreateInvite = match body.is_empty() {
    true => CreateInvite::default(),
    false => serde_json::from_slice(&body).map_err(|e| Refusal::bad(e.to_string()))?,
  };
  caller.as_person()?;
  let mut db = app.db.acquire().await?;
  caller.limit(&mut db, "create_invite").await?;
  let me = &caller.account;
  let mut group = input.group.clone();
  let mut session = None;
  if let Some(id) = &input.session {
    let found = session_for(&mut db, id, me)
      .await?
      .filter(|s| s.group.is_some());
    let s = found.ok_or_else(|| Refusal::not_found("No such session of a group."))?;
    if group.as_ref().is_some_and(|g| Some(g) != s.group.as_ref()) {
      return Err(Refusal::bad("The session is another group's."));
    }
    group = s.group;
    session = Some(s.id);
  }
  if let Some(id) = &group {
    let own: Option<bool> =
      sqlx::query_scalar(r#"SELECT person IS NOT NULL FROM "group" WHERE id = ?"#)
        .bind(id)
        .fetch_optional(&mut *db)
        .await?;
    match own {
      Some(own) if is_member(&mut db, id, me).await? => {
        if own {
          return Err(Refusal::forbidden(
            "Your own group takes no one else: invite to be friends, or to a group you share.",
          ));
        }
      }
      _ => return Err(Refusal::not_found("No such group.")),
    }
  }
  let now = db::now();
  if db::count(
    &mut db,
    "SELECT count(*) FROM invite WHERE inviter = ? AND accepted_by IS NULL AND expires > ?",
    &[me, &now],
  )
  .await?
    >= MAX_OPEN
  {
    return Err(Refusal::new(
      StatusCode::TOO_MANY_REQUESTS,
      format!("At most {MAX_OPEN} invites are open at once: revoke one first."),
    ));
  }
  let row = InviteRow {
    code: db::random_code(ALPHABET, 10),
    inviter: me.clone(),
    created: now,
    expires: db::from_now(LIFETIME),
    accepted_by: None,
  };
  sqlx::query(r#"INSERT INTO invite (code, inviter, "group", session, created, expires) VALUES (?, ?, ?, ?, ?, ?)"#)
    .bind(&row.code)
    .bind(&row.inviter)
    .bind(&group)
    .bind(&session)
    .bind(&row.created)
    .bind(&row.expires)
    .execute(&mut *db)
    .await?;
  caller
    .record(
      &mut db,
      "create_invite",
      json!({ "group": input.group, "session": input.session }),
    )
    .await?;
  Ok((
    StatusCode::CREATED,
    Json(invite_json(&app, &mut db, &row).await?),
  ))
}

/// The caller's invites that are neither accepted nor expired, newest first.
pub async fn list(State(app): State<App>, caller: Caller) -> Result<Json<Vec<Invite>>> {
  caller.as_person()?;
  let mut db = app.db.acquire().await?;
  let rows: Vec<InviteRow> = sqlx::query_as(
    "SELECT code, inviter, created, expires, accepted_by FROM invite
     WHERE inviter = ? AND accepted_by IS NULL AND expires > ? ORDER BY created DESC",
  )
  .bind(&caller.account)
  .bind(db::now())
  .fetch_all(&mut *db)
  .await?;
  let mut invites = Vec::new();
  for row in &rows {
    invites.push(invite_json(&app, &mut db, row).await?);
  }
  Ok(Json(invites))
}

/// Revokes an open invite of the caller's: its link stops working.
pub async fn revoke(
  State(app): State<App>,
  caller: Caller,
  Path(code): Path<String>,
) -> Result<StatusCode> {
  let mut db = app.db.acquire().await?;
  let gone =
    sqlx::query("DELETE FROM invite WHERE code = ? AND inviter = ? AND accepted_by IS NULL")
      .bind(&code)
      .bind(&caller.account)
      .execute(&mut *db)
      .await?
      .rows_affected();
  if gone == 0 {
    return Err(Refusal::not_found("No such open invite."));
  }
  caller
    .record(&mut db, "revoke_invite", json!({ "code": code }))
    .await?;
  Ok(StatusCode::NO_CONTENT)
}

/// What an invite's link shows before signing in, while it can be accepted: by the person signed
/// in, also once they accepted it themselves, so that the page shows it again after a reload.
pub async fn show(
  State(app): State<App>,
  caller: Option<Caller>,
  headers: HeaderMap,
  Path(code): Path<String>,
) -> Result<Json<InviteShown>> {
  app.limits.invites.allow(&headers, 30)?;
  let gone = || Refusal::not_found("This invite is used, expired or revoked.");
  let mut db = app.db.acquire().await?;
  let row = invite_by_code(&mut db, &code).await?.ok_or_else(gone)?;
  let usable = match &row.accepted_by {
    Some(by) => Some(by) == caller.as_ref().map(|c| &c.account),
    None => row.expires > db::now(),
  };
  if !usable {
    return Err(gone());
  }
  let target = target_of(&mut db, &row.code).await?;
  Ok(Json(InviteShown {
    inviter: face_of(&mut db, &row.inviter).await?,
    group: target.as_ref().map(|t| t.group_name.clone()),
    session: target.and_then(|t| t.session_name),
    expires: row.expires,
  }))
}

/// The invited person accepts, in the browser or with a person token: they become the inviter's friends,
/// where they aren't yet, with a DM, and members of the group, if any. Accepted already, such as
/// on a reload, it shows where it led and changes nothing, so that it never undoes a removal from
/// the group or an unfriending since.
pub async fn accept(
  State(app): State<App>,
  caller: Caller,
  Path(code): Path<String>,
) -> Result<Json<Accepted>> {
  caller.as_person()?;
  let me = &caller.account;
  let mut tx = app.db.begin().await?;
  let now = db::now();
  let row = invite_by_code(&mut tx, &code).await?;
  let Some(row) = row.filter(|row| match &row.accepted_by {
    Some(by) => by == me,
    None => row.expires > now,
  }) else {
    return Err(Refusal::new(
      StatusCode::GONE,
      "This invite is used, expired or revoked: ask for a new one.",
    ));
  };
  if row.inviter == *me {
    return Err(Refusal::bad("This is your own invite: send it to someone."));
  }
  let target = target_of(&mut tx, &row.code).await?;
  let (group, session) = refs_of(target.as_ref());
  if row.accepted_by.is_some() {
    let land = match &target {
      Some(t) if is_member(&mut tx, &t.group, me).await? => match &t.session {
        Some(session) => session.clone(),
        None => general_of(&mut tx, &t.group).await?,
      },
      _ => dm_of(&mut tx, &row.inviter, me).await?,
    };
    let accepted = Accepted {
      inviter: face_of(&mut tx, &row.inviter).await?,
      dm: dm_of(&mut tx, &row.inviter, me).await?,
      group,
      session,
      land: session_json(&mut tx, &land, me).await?,
    };
    tx.commit().await?;
    return Ok(Json(accepted));
  }
  // The inviter may have lost the right to invite since, such as by leaving the group.
  if let Some(t) = &target
    && (t.own || !is_member(&mut tx, &t.group, &row.inviter).await?)
  {
    return Err(Refusal::new(
      StatusCode::GONE,
      "This invite is no longer valid: ask for a new one.",
    ));
  }
  if let Some(t) = &target
    && !is_member(&mut tx, &t.group, me).await?
  {
    if db::count(
      &mut tx,
      r#"SELECT count(*) FROM group_member WHERE "group" = ? AND member = account"#,
      &[&t.group],
    )
    .await?
      >= MAX_MEMBERS
    {
      return Err(Refusal::forbidden(format!(
        "The group is full: it has at most {MAX_MEMBERS} people."
      )));
    }
    let besides = db::count(
      &mut tx,
      r#"SELECT count(*) FROM group_member m JOIN "group" g ON g.id = m."group" WHERE m.member = ? AND g.person IS NULL AND g.trashed IS NULL"#,
      &[me],
    )
    .await?;
    if besides >= MAX_GROUPS {
      return Err(Refusal::forbidden(format!(
        "You are in {MAX_GROUPS} groups besides your own: leave one first."
      )));
    }
  }
  let befriended = !are_friends(&mut tx, &row.inviter, me).await?;
  for (from, to) in [(&row.inviter, me), (me, &row.inviter)] {
    sqlx::query(r#"INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)"#)
      .bind(from)
      .bind(to)
      .bind(&now)
      .execute(&mut *tx)
      .await?;
  }
  let dm = dm_of(&mut tx, &row.inviter, me).await?;
  let joined = match &target {
    Some(t) => {
      sqlx::query(
        r#"INSERT OR IGNORE INTO group_member ("group", member, account) VALUES (?, ?, ?)"#,
      )
      .bind(&t.group)
      .bind(me)
      .bind(me)
      .execute(&mut *tx)
      .await?
      .rows_affected()
        > 0
    }
    None => false,
  };
  sqlx::query("UPDATE invite SET accepted_by = ?, accepted = coalesce(accepted, ?) WHERE code = ?")
    .bind(me)
    .bind(&now)
    .bind(&row.code)
    .execute(&mut *tx)
    .await?;
  let land = match &target {
    Some(t) => match &t.session {
      Some(session) => session.clone(),
      None => general_of(&mut tx, &t.group).await?,
    },
    None => dm.clone(),
  };
  let inviter = face_of(&mut tx, &row.inviter).await?;
  let own = own_group_of(&mut tx, &row.inviter).await?;
  let inbox = general_of(&mut tx, &own).await?;
  let to = target
    .as_ref()
    .map(|t| format!(" to the group {}", quoted(&t.group_name)))
    .unwrap_or_default();
  let friends = if befriended {
    ": you are friends, with a DM"
  } else {
    ""
  };
  let text = format!("{} accepted your invite{to}{friends}.", caller.person);
  transport::announce(&app, &mut tx, &inbox, &text, &[], &[]).await?;
  if let Some(t) = &target
    && joined
  {
    let general = general_of(&mut tx, &t.group).await?;
    let text = format!(
      "{} joined the group, by {}'s invite.",
      caller.person, inviter.name
    );
    transport::announce(&app, &mut tx, &general, &text, &[], &[]).await?;
  }
  let accepted = Accepted {
    inviter,
    dm,
    group,
    session,
    land: session_json(&mut tx, &land, me).await?,
  };
  tx.commit().await?;
  Ok(Json(accepted))
}
