//! The transport: each session's log, its participants, and each participant's stream with the
//! receives waiting on it. Observing a session reads its log (`observe`); receiving is a
//! participant's own stream (`receive`), a person's or an agent's alike.
//!
//! What waits is in memory (`Live`), everything else in the database. A participant's presence
//! is held, never declared: a waiting receive holds it, and when the receive ends, by an answer,
//! a refusal or its connection dropping, its guard's destructor lets it go, after a grace.

use std::{
  collections::{BTreeMap, HashMap},
  sync::Mutex,
  time::Duration,
};

use axum::http::StatusCode;
use sqlx::Connection;
use tokio::{sync::oneshot, time::Instant};
use vibetogether_protocol::{
  Entry, Item, JOIN_TYPE, LEAVE_TYPE, LogQuery, MAX_NAMED, MAX_PAYLOAD, Named, Notify, Participant,
  Presence, Reach, ReceiveQuery, Received, SYSTEM_NAME, Sent, State, is_message, is_name_part,
  names_of, renamed, with_mentions,
};

use crate::{
  App,
  caller::Caller,
  changes::revision_of,
  db::{self, Db, session_for},
  error::{Refusal, Result},
};

/// The most text an entry carries inline; a longer payload is fetched.
const MAX_INLINE: usize = 64 * 1024;
/// About the most one answer carries, of its entries' inline text; it always carries one.
const MAX_ANSWER: usize = 1024 * 1024;
/// How long an agent stays its login's after that login last acted as it, while no receive of it
/// waits.
/// How long a participant stays awake or asleep after its last receive ended, so that receiving
/// again keeps it.
const GRACE: Duration = Duration::from_secs(60);
/// The most receives of one account waiting at once.
const MAX_WAITING: usize = 64;
/// The most system messages one session gets in an hour; past it, they are dropped.
const MAX_ANNOUNCED: u32 = 60;

/// The participant a request acts as: the person, or one of their agents.
#[derive(Clone, Debug)]
pub struct Acting {
  pub account: String,
  /// The participant's id: the account's own for the person, the agent's otherwise.
  pub id: String,
  /// Its name now: `<account>` or `<account>/<agent>`.
  pub name: String,
  /// The app the person acts through, by its name, which their entries name.
  pub app: Option<String>,
}

/// The participant a request acts as: the agent an agent token names, else the person.
pub fn acting(caller: &Caller) -> Acting {
  match &caller.agent {
    Some(agent) => Acting {
      account: caller.account.clone(),
      id: agent.id.clone(),
      name: agent.name.clone(),
      app: None,
    },
    None => Acting {
      account: caller.account.clone(),
      id: caller.account.clone(),
      name: caller.person.clone(),
      app: caller.app().map(str::to_string),
    },
  }
}

/// The participant a name stands for now: `login` the person, `login/name` their agent of that
/// name outside the trash. Returns its account and its id.
pub async fn participant_by_name(db: &mut Db, name: &str) -> Result<Option<(String, String)>> {
  let mut parts = name.split('/');
  let (Some(login), agent, None) = (parts.next(), parts.next(), parts.next()) else {
    return Ok(None);
  };
  if login.is_empty() || agent.is_some_and(|a| !is_name_part(a)) {
    return Ok(None);
  }
  let account: Option<String> = sqlx::query_scalar("SELECT id FROM account WHERE login = ?")
    .bind(login)
    .fetch_optional(&mut *db)
    .await?;
  let Some(account) = account else {
    return Ok(None);
  };
  let Some(agent) = agent else {
    return Ok(Some((account.clone(), account)));
  };
  let id: Option<String> =
    sqlx::query_scalar("SELECT id FROM agent WHERE account = ? AND name = ? AND trashed IS NULL")
      .bind(&account)
      .bind(agent)
      .fetch_optional(db)
      .await?;
  Ok(id.map(|id| (account, id)))
}

// What waits, in memory.

/// The receives waiting, and when each participant's last receive started or ended.
#[derive(Default)]
pub struct Live(Mutex<Inner>);

#[derive(Default)]
struct Inner {
  receivers: HashMap<u64, Receiver>,
  next: u64,
  heard: HashMap<String, Heard>,
  announced: HashMap<String, (Instant, u32)>,
}

/// What a receive holds while it waits: its participant's state, and whether it is not to be
/// disturbed.
#[derive(Clone, Copy, PartialEq)]
struct Holds {
  state: State,
  dnd: bool,
}

/// A receive waiting on its participant's stream, with what it holds.
struct Receiver {
  account: String,
  participant: String,
  login: String,
  held: Holds,
  /// Ends it: with nothing, it answers what there is; with a refusal, it refuses.
  end: oneshot::Sender<Option<Refusal>>,
}

/// When a participant's last receive started or ended, and the state it held.
struct Heard {
  account: String,
  at: Instant,
  held: Holds,
}

impl Inner {
  /// A participant's presence: the state its receives hold while one waits, `awake` where any of
  /// several does, or the one its last held where it ended moments ago, `offline` otherwise.
  fn presence(&self, id: &str) -> Presence {
    let mut held = None;
    for r in self.receivers.values().filter(|r| r.participant == id) {
      if held != Some(State::Awake) {
        held = Some(r.held.state);
      }
    }
    let held = held.or_else(|| self.lately(id).map(|h| h.state));
    match held {
      Some(State::Awake) => Presence::Awake,
      Some(State::Asleep) => Presence::Asleep,
      None => Presence::Offline,
    }
  }

  /// Whether a participant is not to be disturbed: where any of its receives waiting holds it, or
  /// the one its last held where it ended moments ago.
  fn dnd(&self, id: &str) -> bool {
    let mut waiting = self
      .receivers
      .values()
      .filter(|r| r.participant == id)
      .peekable();
    if waiting.peek().is_some() {
      return waiting.any(|r| r.held.dnd);
    }
    self.lately(id).is_some_and(|h| h.dnd)
  }

  /// What the participant's last receive held, where it ended moments ago.
  fn lately(&self, id: &str) -> Option<Holds> {
    self
      .heard
      .get(id)
      .filter(|h| h.at.elapsed() < GRACE)
      .map(|h| h.held)
  }
}

impl Live {
  pub fn presence(&self, id: &str) -> Presence {
    self.0.lock().unwrap().presence(id)
  }

  pub fn dnd(&self, id: &str) -> bool {
    self.0.lock().unwrap().dnd(id)
  }

  /// Every participant awake or asleep now: its account, its id, its state and whether it is not
  /// to be disturbed.
  pub fn reachable(&self) -> Vec<(String, String, State, bool)> {
    let inner = self.0.lock().unwrap();
    let mut ids: HashMap<&str, &str> = inner
      .heard
      .iter()
      .map(|(id, h)| (id.as_str(), h.account.as_str()))
      .collect();
    for r in inner.receivers.values() {
      ids.insert(&r.participant, &r.account);
    }
    ids
      .into_iter()
      .filter_map(|(id, account)| {
        let state = match inner.presence(id) {
          Presence::Awake => State::Awake,
          Presence::Asleep => State::Asleep,
          _ => return None,
        };
        Some((account.to_string(), id.to_string(), state, inner.dnd(id)))
      })
      .collect()
  }
}

/// Makes `change` to what the participant `id`'s presence comes from: where the presence
/// changes, what waits for a change is woken.
fn change<T>(app: &App, id: &str, change: impl FnOnce(&mut Inner) -> T) -> T {
  let (was, result, is) = {
    let mut inner = app.live.0.lock().unwrap();
    let was = (inner.presence(id), inner.dnd(id));
    let result = change(&mut inner);
    (was, result, (inner.presence(id), inner.dnd(id)))
  };
  if was != is {
    app.changes.written();
  }
  result
}

/// Notes that a receive of the participant started or ended, holding `held`: it stays awake or
/// asleep moments longer, so that receiving again keeps it, and goes offline after.
fn heard(app: &App, inner: &mut Inner, account: &str, id: &str, held: Holds) {
  inner.heard.insert(
    id.to_string(),
    Heard {
      account: account.to_string(),
      at: Instant::now(),
      held,
    },
  );
  let (app, id) = (app.clone(), id.to_string());
  tokio::spawn(async move {
    tokio::time::sleep(GRACE + Duration::from_millis(100)).await;
    change(&app, &id, |inner| {
      if inner
        .heard
        .get(&id)
        .is_some_and(|h| h.at.elapsed() >= GRACE)
      {
        inner.heard.remove(&id);
      }
    });
  });
}

/// Ends the receives `which` picks, each with the refusal `why` gives it, or with what there is.
fn end(app: &App, which: impl Fn(&Receiver) -> bool, why: impl Fn() -> Option<Refusal>) {
  let ended: Vec<(String, String, Holds)> = {
    let inner = app.live.0.lock().unwrap();
    inner
      .receivers
      .values()
      .filter(|r| which(r))
      .map(|r| (r.account.clone(), r.participant.clone(), r.held))
      .collect()
  };
  let mut ended = ended;
  ended.sort_by(|a, b| a.1.cmp(&b.1));
  ended.dedup_by(|a, b| a.1 == b.1);
  for (account, id, state) in ended {
    change(app, &id, |inner| {
      let keys: Vec<u64> = inner
        .receivers
        .iter()
        .filter(|(_, r)| r.participant == id && which(r))
        .map(|(k, _)| *k)
        .collect();
      for key in keys {
        if let Some(r) = inner.receivers.remove(&key) {
          let _ = r.end.send(why());
        }
      }
      heard(app, inner, &account, &id, state);
    });
  }
}

/// Wakes the receives of the participants an entry reached.
fn wake(app: &App, reached: &[String]) {
  end(app, |r| reached.contains(&r.participant), || None);
}

/// Cuts off the receives of a login, once it is revoked.
pub fn end_login(app: &App, login: &str) {
  end(
    app,
    |r| r.login == login,
    || Some(Refusal::forbidden("The login is revoked.")),
  );
}

/// Cuts off the receives of an account, once it is deleted.
pub fn end_account(app: &App, account: &str) {
  end(
    app,
    |r| r.account == account,
    || Some(Refusal::forbidden("The account is deleted.")),
  );
}

/// Starts what runs on its own, every hour: an item unread for a week goes, an agent idle for
/// `TRASH_DAYS` goes into the trash, and the trash is purged of what was deleted `TRASH_DAYS` ago.
pub fn start(app: &App) {
  let app = app.clone();
  tokio::spawn(async move {
    let mut hourly = tokio::time::interval(Duration::from_secs(3600));
    loop {
      hourly.tick().await;
      let gone = sqlx::query("DELETE FROM stream WHERE created < ?")
        .bind(db::from_now(-7 * 86400))
        .execute(&app.db)
        .await;
      if let Err(e) = gone {
        tracing::error!("dropping week-old items: {e}");
      }
      let purged = async {
        let mut db = app.db.acquire().await?;
        crate::trash::sweep_idle(&app, &mut db).await?;
        crate::trash::purge(&mut db).await
      };
      if let Err(e) = purged.await {
        tracing::error!("purging the trash: {e:?}");
      }
    }
  });
}

// Holding an agent.

#[derive(sqlx::FromRow)]
struct Held {
  holder: Option<String>,
  trashed: Option<String>,
}

pub async fn login_lasts(db: &mut Db, login: &str) -> Result<bool> {
  Ok(
    sqlx::query("SELECT 1 FROM login WHERE id = ? AND (expires IS NULL OR expires > ?)")
      .bind(login)
      .bind(db::now())
      .fetch_optional(db)
      .await?
      .is_some(),
  )
}

/// Has `login` act as the participant, which for an agent is one mind at a time, so held by one
/// login: another login takes it once its holder is revoked, or has neither acted as it for an
/// hour nor has a receive of it waiting. A person is no agent, and every login of theirs is them.
pub async fn hold(app: &App, db: &mut Db, p: &Acting, login: &str) -> Result<()> {
  if p.id == p.account {
    return Ok(());
  }
  let agent: Held =
    sqlx::query_as("SELECT holder, trashed FROM agent WHERE id = ? AND account = ?")
      .bind(&p.id)
      .bind(&p.account)
      .fetch_optional(&mut *db)
      .await?
      .ok_or_else(|| Refusal::not_found("No such agent."))?;
  if agent.trashed.is_some() {
    return Err(Refusal::forbidden(
      "This agent is in the trash: it receives and sends no more.",
    ));
  }
  // The holder keeps it until revoked, however long it is quiet: another token of the account
  // never takes it over, Luis's decision (2026-11-16). One statement, so two logins racing for
  // a free agent can't both take it.
  let other = agent.holder.as_ref().filter(|holder| *holder != login);
  let now = db::now();
  let taken = sqlx::query(
    "UPDATE agent SET holder = ?1, seen = ?2 WHERE id = ?3 AND (holder IS NULL OR holder = ?1
     OR NOT EXISTS (SELECT 1 FROM login WHERE id = agent.holder AND (expires IS NULL OR expires > ?2)))",
  )
  .bind(login)
  .bind(&now)
  .bind(&p.id)
  .execute(&mut *db)
  .await?;
  if taken.rows_affected() == 0 {
    return Err(Refusal::conflict(
      "Another login holds this agent, which is one mind at a time: it takes it only once that login is revoked.",
    ));
  }
  if other.is_some() {
    end(
      app,
      |r| r.participant == p.id && r.login != login,
      || Some(Refusal::forbidden("Another login took this agent.")),
    );
  }
  Ok(())
}

// The log.

#[derive(sqlx::FromRow)]
struct EntryRow {
  n: i64,
  time: String,
  sender: String,
  participant: Option<String>,
  #[sqlx(rename = "type")]
  ty: String,
  size: i64,
  filename: Option<String>,
  text: Option<String>,
  app: Option<String>,
}

impl From<EntryRow> for Entry {
  fn from(row: EntryRow) -> Self {
    Entry {
      n: row.n as u64,
      time: row.time,
      from: row.sender,
      from_id: row.participant,
      ty: row.ty,
      size: row.size as u64,
      filename: row.filename,
      text: row.text,
      app: row.app,
    }
  }
}

/// The payload as text where it is short text: any `text/*`, `application/json` or `+json` type.
fn inline_text(ty: &str, payload: &[u8]) -> Option<String> {
  let essence = ty
    .split(';')
    .next()
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase();
  let textual =
    essence.starts_with("text/") || essence == "application/json" || essence.ends_with("+json");
  if !textual || payload.len() > MAX_INLINE {
    return None;
  }
  String::from_utf8(payload.to_vec()).ok()
}

/// Appends an entry from `sender`, by its name and its participant's id, none for Vibe
/// Together's own, and the app it came through: its number.
async fn append(
  db: &mut Db,
  session: &str,
  sender: (&str, Option<&str>, Option<&str>),
  ty: &str,
  payload: &[u8],
  filename: Option<&str>,
) -> Result<i64> {
  let n: i64 = sqlx::query_scalar("SELECT coalesce(max(n), 0) + 1 FROM entry WHERE session = ?")
    .bind(session)
    .fetch_one(&mut *db)
    .await?;
  let text = inline_text(ty, payload);
  let blob = (text.is_none() && !payload.is_empty()).then_some(payload);
  sqlx::query(
    "INSERT INTO entry (session, n, time, sender, participant, type, size, filename, text, payload, app)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  .bind(session)
  .bind(n)
  .bind(
    jiff::Timestamp::now()
      .strftime("%Y-%m-%dT%H:%M:%SZ")
      .to_string(),
  )
  .bind(sender.0)
  .bind(sender.1)
  .bind(ty)
  .bind(payload.len() as i64)
  .bind(filename)
  .bind(text)
  .bind(blob)
  .bind(sender.2)
  .execute(db)
  .await?;
  Ok(n)
}

/// Delivers entry `n` of `session`, from the participant `sender`, none for Vibe Together's own,
/// as an item of the stream of each participant it reaches: a message reaches every name its
/// `ping` or `fyi` lists, as the name stands as it is sent, where it sees the session, and for an
/// explicit `*` every participant in the session, as a ping; any entry reaches every participant
/// in the session, the sender left out. Returns the participants reached, and the names that see
/// the session not.
async fn deliver(
  db: &mut Db,
  session: &str,
  n: i64,
  sender: Option<&str>,
  ty: &str,
) -> Result<(Vec<String>, Vec<String>)> {
  let inside: Vec<(String, String)> =
    sqlx::query_as("SELECT id, account FROM participant WHERE session = ? AND inside = 1")
      .bind(session)
      .fetch_all(&mut *db)
      .await?;
  let mut reached: Vec<(String, String, Reach)> = Vec::new();
  let mut unreached = Vec::new();
  if is_message(ty) {
    let named = names_of(ty, "ping");
    let mut ping: Vec<String> = Vec::new();
    for name in named.iter().filter(|n| *n != "*") {
      if !ping.contains(name) {
        ping.push(name.clone());
      }
    }
    let mut fyi: Vec<String> = Vec::new();
    for name in names_of(ty, "fyi") {
      if !ping.contains(&name) && !fyi.contains(&name) {
        fyi.push(name);
      }
    }
    if ping.len() + fyi.len() > MAX_NAMED {
      return Err(Refusal::bad(format!(
        "A message names at most {MAX_NAMED} in its ping and fyi together."
      )));
    }
    for (name, reach) in ping
      .iter()
      .map(|n| (n, Reach::Ping))
      .chain(fyi.iter().map(|n| (n, Reach::Fyi)))
    {
      let found = match participant_by_name(db, name).await? {
        None if reach == Reach::Ping => woken_by_ping(db, session, name).await?,
        found => found,
      };
      if found
        .as_ref()
        .is_some_and(|(_, id)| Some(id.as_str()) == sender)
      {
        continue;
      }
      let Some((account, id)) = found else {
        unreached.push(name.clone());
        continue;
      };
      if session_for(db, session, &id).await?.is_none() {
        unreached.push(name.clone());
        continue;
      }
      match reached.iter_mut().find(|(r, _, _)| *r == id) {
        Some(existing) if reach == Reach::Ping => existing.2 = Reach::Ping,
        Some(_) => {}
        None => reached.push((id, account, reach)),
      }
    }
    if named.iter().any(|n| n == "*") {
      for (id, account) in inside.iter().filter(|(id, _)| Some(id.as_str()) != sender) {
        if session_for(db, session, id).await?.is_none() {
          continue;
        }
        match reached.iter_mut().find(|(r, _, _)| r == id) {
          Some(existing) => existing.2 = Reach::Ping,
          None => reached.push((id.clone(), account.clone(), Reach::Ping)),
        }
      }
    }
  }
  for (id, account) in &inside {
    if Some(id.as_str()) != sender
      && !reached.iter().any(|(r, _, _)| r == id)
      && session_for(db, session, id).await?.is_some()
    {
      reached.push((id.clone(), account.clone(), Reach::Session));
    }
  }
  let now = db::now();
  for (id, account, reach) in &reached {
    let last: i64 = sqlx::query_scalar(
      "INSERT INTO stream_head (participant, account, last, received, read) VALUES (?, ?, 1, 0, 0)
       ON CONFLICT DO UPDATE SET last = last + 1 RETURNING last",
    )
    .bind(id)
    .bind(account)
    .fetch_one(&mut *db)
    .await?;
    sqlx::query(
      "INSERT INTO stream (participant, n, session, entry, reach, created) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(last)
    .bind(session)
    .bind(n)
    .bind(reach_name(*reach))
    .bind(&now)
    .execute(&mut *db)
    .await?;
  }
  Ok((
    reached.into_iter().map(|(id, _, _)| id).collect(),
    unreached,
  ))
}

fn reach_name(reach: Reach) -> &'static str {
  match reach {
    Reach::Ping => "ping",
    Reach::Fyi => "fyi",
    Reach::Session => "session",
  }
}

fn notify_of(name: &str) -> Notify {
  match name {
    "mentions" => Notify::Mentions,
    _ => Notify::All,
  }
}

/// Sets what wakes the participant in a session it is in, which everyone there sees.
pub async fn set_notify(
  app: &App,
  db: &mut Db,
  p: &Acting,
  session: &str,
  login: &str,
  notify: Notify,
) -> Result<()> {
  hold(app, db, p, login).await?;
  let set =
    sqlx::query("UPDATE participant SET notify = ? WHERE session = ? AND id = ? AND inside = 1")
      .bind(match notify {
        Notify::All => "all",
        Notify::Mentions => "mentions",
      })
      .bind(session)
      .bind(&p.id)
      .execute(&mut *db)
      .await?;
  if set.rows_affected() == 0 {
    return Err(Refusal::forbidden("Join the session first."));
  }
  app.changes.written();
  Ok(())
}

fn reach_of(name: &str) -> Reach {
  match name {
    "ping" => Reach::Ping,
    "fyi" => Reach::Fyi,
    _ => Reach::Session,
  }
}

/// What an entry carries: its payload's type, the payload, and its file name.
pub struct Payload<'a> {
  pub ty: &'a str,
  pub bytes: &'a [u8],
  pub filename: Option<&'a str>,
}

/// The empty payload of a join or a leave.
const MARK: Payload = Payload {
  ty: "",
  bytes: &[],
  filename: None,
};

/// Appends an entry from the participant, with `then` done in the same transaction, and
/// delivers it: its number, and the names it reached not.
async fn append_as(
  app: &App,
  db: &mut Db,
  p: &Acting,
  session: &str,
  payload: Payload<'_>,
  then: Option<&'static str>,
) -> Result<(i64, Vec<String>)> {
  let ty = payload.ty;
  let mut tx = db.begin().await?;
  let n = append(
    &mut tx,
    session,
    (&p.name, Some(&p.id), p.app.as_deref()),
    ty,
    payload.bytes,
    payload.filename,
  )
  .await?;
  if let Some(sql) = then {
    sqlx::query(sql)
      .bind(n)
      .bind(db::now())
      .bind(session)
      .bind(&p.id)
      .bind(&p.account)
      .execute(&mut *tx)
      .await?;
  }
  let (reached, unreached) = deliver(&mut tx, session, n, Some(&p.id), ty).await?;
  tx.commit().await?;
  wake(app, &reached);
  Ok((n, unreached))
}

#[derive(sqlx::FromRow)]
struct Position {
  inside: bool,
  entry: i64,
}

async fn position_of(db: &mut Db, session: &str, id: &str) -> Result<Option<Position>> {
  Ok(
    sqlx::query_as("SELECT inside, entry FROM participant WHERE session = ? AND id = ?")
      .bind(session)
      .bind(id)
      .fetch_optional(db)
      .await?,
  )
}

/// Joins the session, or joins again; joining while in does nothing. Its join entry's number.
pub async fn join(app: &App, db: &mut Db, p: &Acting, session: &str, login: &str) -> Result<i64> {
  hold(app, db, p, login).await?;
  if let Some(position) = position_of(db, session, &p.id).await?.filter(|p| p.inside) {
    return Ok(position.entry);
  }
  // A join is an entry that reaches every participant in the session, so it counts as one sent.
  app.limits.adds(&p.account, 0, &app.config.database)?;
  let joined =
    "INSERT INTO participant (session, id, account, inside, entry, received, read, since)
    VALUES (?3, ?4, ?5, 1, ?1, 0, 0, ?2)
    ON CONFLICT DO UPDATE SET inside = 1, entry = excluded.entry, since = excluded.since";
  let (n, _) = append_as(
    app,
    db,
    p,
    session,
    Payload {
      ty: JOIN_TYPE,
      ..MARK
    },
    Some(joined),
  )
  .await?;
  Ok(n)
}

/// The update a leave makes to its participant, in the order `append_as` binds.
const LEFT: &str = "UPDATE participant SET inside = 0, entry = ?1, since = ?2 WHERE session = ?3 AND id = ?4 AND account = ?5";

/// Leaves the session; leaving twice does nothing. Its leave entry's number.
pub async fn leave(app: &App, db: &mut Db, p: &Acting, session: &str, login: &str) -> Result<i64> {
  let position = position_of(db, session, &p.id).await?;
  if let Some(position) = position.as_ref().filter(|p| !p.inside) {
    return Ok(position.entry);
  }
  hold(app, db, p, login).await?;
  if position.is_none() {
    return Err(Refusal::forbidden(
      "Join the session first, or join again after leaving.",
    ));
  }
  app.limits.adds(&p.account, 0, &app.config.database)?;
  let (n, _) = append_as(
    app,
    db,
    p,
    session,
    Payload {
      ty: LEAVE_TYPE,
      ..MARK
    },
    Some(LEFT),
  )
  .await?;
  Ok(n)
}

/// The agent `name` stands for, `login/name`, where the idle sweep put it into the trash and it
/// is in the session, brought back by the ping (`trash::wake_idle`). Its account and its id.
async fn woken_by_ping(db: &mut Db, session: &str, name: &str) -> Result<Option<(String, String)>> {
  let Some((account, id)) = idle_by_name(db, name).await? else {
    return Ok(None);
  };
  let inside = position_of(db, session, &id)
    .await?
    .is_some_and(|p| p.inside);
  if inside
    && session_for(db, session, &id).await?.is_some()
    && crate::trash::wake_idle(db, &id).await?
  {
    return Ok(Some((account, id)));
  }
  Ok(None)
}

/// The agent `login/name` stands for in the trash, where the idle sweep put it there: hidden, but
/// still in its sessions and groups. Its account and its id.
pub async fn idle_by_name(db: &mut Db, name: &str) -> Result<Option<(String, String)>> {
  let Some((login, agent)) = name.split_once('/') else {
    return Ok(None);
  };
  Ok(
    sqlx::query_as(
      "SELECT ag.account, ag.id FROM agent ag JOIN account a ON a.id = ag.account
       WHERE a.login = ? AND ag.name = ? AND ag.trashed_by = ? ORDER BY ag.trashed DESC LIMIT 1",
    )
    .bind(login)
    .bind(agent)
    .bind(SYSTEM_NAME)
    .fetch_optional(db)
    .await?,
  )
}

/// A message's type with each name in its `ping` or `fyi` that is no more than an agent's own
/// name, such as `lead`, as the full name of the sender's person's agent of that name, where one
/// is outside the trash, or idle in it (`trash::wake_idle`), so that everyone sees whom it named;
/// any other name stays as it is.
async fn with_own_agents(db: &mut Db, p: &Acting, ty: &str) -> Result<String> {
  if !is_message(ty) {
    return Ok(ty.to_string());
  }
  let login = p.name.split('/').next().unwrap_or_default();
  let mut own = HashMap::new();
  for name in names_of(ty, "ping").into_iter().chain(names_of(ty, "fyi")) {
    if !is_name_part(&name) || own.contains_key(&name) {
      continue;
    }
    let agent: Option<String> = sqlx::query_scalar(
      "SELECT name FROM agent WHERE account = ? AND name = ? AND (trashed IS NULL OR trashed_by = ?)
       LIMIT 1",
    )
    .bind(&p.account)
    .bind(&name)
    .bind(SYSTEM_NAME)
    .fetch_optional(&mut *db)
    .await?;
    if let Some(agent) = agent {
      own.insert(name, format!("{login}/{agent}"));
    }
  }
  if own.is_empty() {
    return Ok(ty.to_string());
  }
  Ok(renamed(ty, |name| {
    own.get(name).cloned().unwrap_or_else(|| name.to_string())
  }))
}

/// Sends an entry: its number, and the names its `ping` or `fyi` lists that don't see the session.
pub async fn send(
  app: &App,
  db: &mut Db,
  p: &Acting,
  session: &str,
  login: &str,
  payload: Payload<'_>,
) -> Result<Sent> {
  hold(app, db, p, login).await?;
  if !position_of(db, session, &p.id)
    .await?
    .is_some_and(|p| p.inside)
  {
    return Err(Refusal::forbidden(
      "Join the session first, or join again after leaving.",
    ));
  }
  if payload.bytes.len() > MAX_PAYLOAD {
    return Err(too_large());
  }
  app
    .limits
    .adds(&p.account, payload.bytes.len() as u64, &app.config.database)?;
  let ty = match std::str::from_utf8(payload.bytes) {
    Ok(text) => with_mentions(payload.ty, text),
    Err(_) => payload.ty.to_string(),
  };
  let ty = with_own_agents(db, p, &ty).await?;
  let payload = Payload { ty: &ty, ..payload };
  let (n, unreached) = append_as(app, db, p, session, payload, None).await?;
  Ok(Sent {
    n: n as u64,
    unreached: (!unreached.is_empty()).then_some(unreached),
  })
}

pub fn too_large() -> Refusal {
  Refusal::new(
    StatusCode::PAYLOAD_TOO_LARGE,
    format!("A payload is at most {} MB.", MAX_PAYLOAD / 1024 / 1024),
  )
}

/// Has the participant `id` leave every session of `group` it is in, once it is no longer in the
/// group.
pub async fn leave_group(app: &App, db: &mut Db, group: &str, id: &str) -> Result<()> {
  let inside: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
    r#"SELECT pa.session, pa.account, a.login, ag.name FROM participant pa
       JOIN account a ON a.id = pa.account LEFT JOIN agent ag ON ag.id = pa.id
       JOIN session s ON s.id = pa.session LEFT JOIN project p ON p.id = s.project
       LEFT JOIN group_session gs ON gs.session = s.id
       WHERE pa.id = ? AND pa.inside = 1 AND coalesce(p."group", gs."group") = ?"#,
  )
  .bind(id)
  .bind(group)
  .fetch_all(&mut *db)
  .await?;
  for (session, account, login, agent) in inside {
    let p = Acting {
      account,
      id: id.to_string(),
      name: agent.map_or(login.clone(), |agent| format!("{login}/{agent}")),
      app: None,
    };
    let leave = Payload {
      ty: LEAVE_TYPE,
      ..MARK
    };
    append_as(app, db, &p, &session, leave, Some(LEFT)).await?;
  }
  Ok(())
}

/// Deletes the agent, by `by`, into the trash: it leaves every session it is in, and every group
/// but its person's own, receives and sends no more, its stream goes, and its name is free for
/// another.
pub async fn trash_agent(app: &App, db: &mut Db, p: &Acting, by: &str) -> Result<()> {
  let sessions: Vec<String> =
    sqlx::query_scalar("SELECT session FROM participant WHERE id = ? AND inside = 1")
      .bind(&p.id)
      .fetch_all(&mut *db)
      .await?;
  for session in sessions {
    append_as(
      app,
      db,
      p,
      &session,
      Payload {
        ty: LEAVE_TYPE,
        ..MARK
      },
      Some(LEFT),
    )
    .await?;
  }
  let mut tx = db.begin().await?;
  // It keeps its holder, so that restored (`trash`) it is that login's again, and no other's.
  let trashed = sqlx::query(
    "UPDATE agent SET trashed = ?, trashed_by = ? WHERE id = ? AND account = ?
     AND (trashed IS NULL OR trashed_by = ?)",
  )
  .bind(db::now())
  .bind(by)
  .bind(&p.id)
  .bind(&p.account)
  .bind(SYSTEM_NAME)
  .execute(&mut *tx)
  .await?;
  // Deleted meanwhile by another, it is not deleted twice.
  if trashed.rows_affected() == 0 {
    return Err(Refusal::not_found("No such agent."));
  }
  sqlx::query("DELETE FROM status WHERE participant = ?")
    .bind(&p.id)
    .execute(&mut *tx)
    .await?;
  sqlx::query("DELETE FROM stream_head WHERE participant = ?")
    .bind(&p.id)
    .execute(&mut *tx)
    .await?;
  sqlx::query(
    r#"DELETE FROM group_member WHERE member = ?
       AND "group" NOT IN (SELECT id FROM "group" WHERE person = group_member.account)"#,
  )
  .bind(&p.id)
  .execute(&mut *tx)
  .await?;
  tx.commit().await?;
  end(
    app,
    |r| r.participant == p.id,
    || Some(Refusal::forbidden("The agent is in the trash.")),
  );
  Ok(())
}

/// A name as a system message quotes it: a code span, so that a group's or session's name,
/// which its maker chose, reads as a name and never as more of the message.
pub fn quoted(name: &str) -> String {
  let mut flat = String::new();
  for c in name.chars() {
    if c == '`' || c.is_whitespace() {
      if !flat.ends_with(' ') {
        flat.push(' ');
      }
    } else {
      flat.push(c);
    }
  }
  format!("`{}`", flat.trim())
}

/// Posts a system message, from `vibetogether`, to `session`, such as a group's general:
/// markdown, which pings and tells whom `ping` and `fyi` name, and no one where they are empty.
/// Every name in `text` goes through `quoted`.
pub async fn announce(
  app: &App,
  db: &mut Db,
  session: &str,
  text: &str,
  ping: &[String],
  fyi: &[String],
) -> Result<()> {
  {
    let mut inner = app.live.0.lock().unwrap();
    if inner.announced.len() > 10_000 {
      inner.announced.clear();
    }
    let now = Instant::now();
    let count = inner
      .announced
      .entry(session.to_string())
      .or_insert((now, 0));
    if now.duration_since(count.0) > Duration::from_secs(3600) {
      *count = (now, 0);
    }
    count.1 += 1;
    if count.1 > MAX_ANNOUNCED {
      return Ok(());
    }
  }
  let ty = vibetogether_protocol::message_type("text/markdown; charset=utf-8", Some(ping), fyi);
  let mut tx = db.begin().await?;
  let n = append(
    &mut tx,
    session,
    (SYSTEM_NAME, None, None),
    &ty,
    text.as_bytes(),
    None,
  )
  .await?;
  let (reached, _) = deliver(&mut tx, session, n, None, &ty).await?;
  tx.commit().await?;
  wake(app, &reached);
  Ok(())
}

// Observing.

#[derive(sqlx::FromRow)]
struct ParticipantRow {
  id: String,
  login: String,
  agent: Option<String>,
  received: i64,
  read: i64,
  since: String,
  status: Option<String>,
  notify: String,
}

/// Who is in the session, by name, with their positions, their presence and their status.
pub async fn participants_of(
  app: &App,
  db: &mut Db,
  session: &str,
) -> Result<BTreeMap<String, Participant>> {
  let rows: Vec<ParticipantRow> = sqlx::query_as(
    "SELECT p.id, a.login, ag.name AS agent, p.received, p.read, p.since, st.text AS status,
     p.notify FROM participant p JOIN account a ON a.id = p.account LEFT JOIN agent ag ON ag.id = p.id
     LEFT JOIN status st ON st.participant = p.id
     WHERE p.session = ? AND p.inside = 1 AND ag.trashed IS NULL",
  )
  .bind(session)
  .fetch_all(db)
  .await?;
  Ok(
    rows
      .into_iter()
      .map(|row| {
        let presence = app.live.presence(&row.id);
        let dnd = app.live.dnd(&row.id);
        let name = match row.agent {
          Some(agent) => format!("{}/{agent}", row.login),
          None => row.login,
        };
        let participant = Participant {
          since: (presence == Presence::Offline).then_some(row.since),
          id: row.id,
          received: row.received as u64,
          read: row.read as u64,
          dnd,
          presence,
          notify: notify_of(&row.notify),
          status: row.status,
        };
        (name, participant)
      })
      .collect(),
  )
}

/// The entries of `session` after `after`, about one answer's worth.
async fn entries_of(db: &mut Db, session: &str, after: u64) -> Result<Vec<Entry>> {
  let rows: Vec<EntryRow> = sqlx::query_as(
    "SELECT n, time, sender, participant, type, size, filename, text, app FROM entry
     WHERE session = ? AND n > ? ORDER BY n LIMIT 1000",
  )
  .bind(session)
  .bind(after as i64)
  .fetch_all(db)
  .await?;
  let mut entries = Vec::new();
  let mut bytes = 0;
  for row in rows {
    bytes += row.text.as_ref().map_or(0, String::len) + 200;
    if !entries.is_empty() && bytes > MAX_ANSWER {
      break;
    }
    entries.push(row.into());
  }
  Ok(entries)
}

/// Observes a session, which has no side effects: its entries after `after`, and who is in it.
/// With a `revision` of who is in it, it waits until there is an entry after `after` or who is in
/// it differs, at most `wait` seconds.
pub async fn observe(
  app: &App,
  caller: &Caller,
  session: &str,
  query: LogQuery,
) -> Result<vibetogether_protocol::Log> {
  let after = query.after.unwrap_or(0);
  let current = move || async move {
    let mut db = app.db.acquire().await?;
    if !login_lasts(&mut db, &caller.login).await?
      || session_for(&mut db, session, caller.who()).await?.is_none()
    {
      return Err(Refusal::not_found("No such session."));
    }
    let entries = entries_of(&mut db, session, after).await?;
    let participants = participants_of(app, &mut db, session).await?;
    let revision = revision_of(&participants);
    Ok(vibetogether_protocol::Log {
      entries,
      participants,
      revision,
    })
  };
  let differs = |log: &vibetogether_protocol::Log| {
    !log.entries.is_empty() || Some(&log.revision) != query.revision.as_ref()
  };
  app
    .changes
    .changed(&caller.account, current, differs, query.wait)
    .await
}

// Receiving.

/// Stores the participant's positions in its stream, each at least as it was, `received` at
/// most its last item and `read` at most `received`. Each moves the participant's position of
/// the same name in the sessions of the items it passes, to the last entry there; the items read
/// go. Returns the positions now.
async fn acknowledge(
  app: &App,
  db: &mut Db,
  id: &str,
  received: Option<u64>,
  read: Option<u64>,
) -> Result<(u64, u64)> {
  let head: (i64, i64, i64) =
    sqlx::query_as("SELECT last, received, read FROM stream_head WHERE participant = ?")
      .bind(id)
      .fetch_optional(&mut *db)
      .await?
      .unwrap_or_default();
  let (last, was_received, was_read) = (head.0 as u64, head.1 as u64, head.2 as u64);
  let received = received.unwrap_or(0).max(was_received).min(last);
  let read = read.unwrap_or(0).max(was_read).min(received);
  if (received, read) == (was_received, was_read) {
    return Ok((received, read));
  }
  let mut tx = db.begin().await?;
  for (position, from, to) in [
    ("received", was_received, received),
    ("read", was_read, read),
  ] {
    let moved: Vec<(String, i64)> = sqlx::query_as(
      "SELECT session, max(entry) FROM stream WHERE participant = ? AND n > ? AND n <= ? GROUP BY session",
    )
    .bind(id)
    .bind(from as i64)
    .bind(to as i64)
    .fetch_all(&mut *tx)
    .await?;
    for (session, entry) in moved {
      sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE participant SET {position} = ?1 WHERE session = ?2 AND id = ?3 AND {position} < ?1"
      )))
      .bind(entry)
      .bind(&session)
      .bind(id)
      .execute(&mut *tx)
      .await?;
    }
  }
  sqlx::query("DELETE FROM stream WHERE participant = ? AND n <= ?")
    .bind(id)
    .bind(read as i64)
    .execute(&mut *tx)
    .await?;
  sqlx::query("UPDATE stream_head SET received = ?, read = ? WHERE participant = ?")
    .bind(received as i64)
    .bind(read as i64)
    .bind(id)
    .execute(&mut *tx)
    .await?;
  tx.commit().await?;
  app.changes.written();
  Ok((received, read))
}

#[derive(sqlx::FromRow)]
struct ItemRow {
  item: i64,
  reach: String,
  session: String,
  notify: Option<String>,
  #[sqlx(flatten)]
  entry: EntryRow,
}

/// The participant's items after `after`, about one answer's worth: those of a session it
/// sees no longer go.
async fn items_of(db: &mut Db, id: &str, after: u64) -> Result<Vec<Item>> {
  loop {
    let rows: Vec<ItemRow> = sqlx::query_as(
      "SELECT st.n AS item, st.reach, st.session, p.notify,
       e.n, e.time, e.sender, e.participant, e.type, e.size, e.filename, e.text, e.app
       FROM stream st JOIN entry e ON e.session = st.session AND e.n = st.entry
       LEFT JOIN participant p ON p.session = st.session AND p.id = st.participant
       WHERE st.participant = ? AND st.n > ? ORDER BY st.n LIMIT 1000",
    )
    .bind(id)
    .bind(after as i64)
    .fetch_all(&mut *db)
    .await?;
    let mut sees: HashMap<String, Option<String>> = HashMap::new();
    let mut items = Vec::new();
    let mut bytes = 0;
    let mut dropped = false;
    for row in rows {
      if !sees.contains_key(&row.session) {
        let name = session_for(db, &row.session, id).await?.map(|s| s.name);
        sees.insert(row.session.clone(), name);
      }
      let Some(name) = sees[&row.session].clone() else {
        sqlx::query("DELETE FROM stream WHERE participant = ? AND n = ?")
          .bind(id)
          .bind(row.item)
          .execute(&mut *db)
          .await?;
        dropped = true;
        continue;
      };
      bytes += row.entry.text.as_ref().map_or(0, String::len) + 200;
      if !items.is_empty() && bytes > MAX_ANSWER {
        break;
      }
      items.push(Item {
        n: row.item as u64,
        reach: reach_of(&row.reach),
        notify: row.notify.as_deref().map_or(Notify::All, notify_of),
        session: Named {
          id: row.session,
          name,
        },
        entry: row.entry.into(),
      });
    }
    // A batch all of sessions it sees no longer went: the next may hold what it sees.
    if !items.is_empty() || !dropped {
      return Ok(items);
    }
  }
}

/// A waiting receive, registered while it lives: dropped, by an answer, a refusal or its
/// connection dropping, it lets its participant's presence go, after the grace.
struct Waiting {
  app: App,
  key: u64,
  p: Acting,
  held: Holds,
}

impl Drop for Waiting {
  fn drop(&mut self) {
    let Waiting { app, key, p, held } = self;
    change(app, &p.id, |inner| {
      if inner.receivers.remove(key).is_some() {
        heard(app, inner, &p.account, &p.id, *held);
      }
    });
    // When its last receive ended, which its sessions show while it is offline.
    let (app, p) = (app.clone(), p.clone());
    tokio::spawn(async move {
      let now = db::now();
      let ended = async {
        sqlx::query("UPDATE participant SET since = ? WHERE id = ?")
          .bind(&now)
          .bind(&p.id)
          .execute(&app.db)
          .await?;
        sqlx::query("UPDATE agent SET seen = ? WHERE id = ?")
          .bind(&now)
          .bind(&p.id)
          .execute(&app.db)
          .await
      };
      if let Err(e) = ended.await {
        tracing::error!("ending a receive: {e}");
      }
    });
  }
}

/// A participant receives its stream: the items after `received`, as given or as stored. Naming
/// `received` and `read` stores them first (`acknowledge`). It returns as soon as there is an
/// item, or after `wait` seconds, and holds the participant's `state` and `dnd` meanwhile. An agent has one
/// receive at a time: a newer one ends the one before with 409; a person has one per page.
pub async fn receive(app: &App, p: &Acting, login: &str, query: ReceiveQuery) -> Result<Received> {
  let held = Holds {
    state: query.state.unwrap_or_default(),
    dnd: query.dnd,
  };
  let (received, read) = {
    let mut db = app.db.acquire().await?;
    hold(app, &mut db, p, login).await?;
    if p.id != p.account {
      end(
        app,
        |r| r.participant == p.id,
        || {
          Some(Refusal::conflict(
            "A newer receive of the same agent replaced this one.",
          ))
        },
      );
    }
    acknowledge(app, &mut db, &p.id, query.received, query.read).await?
  };
  let after = query.received.unwrap_or(received).min(received);
  change(app, &p.id, |inner| {
    heard(app, inner, &p.account, &p.id, held)
  });
  let answer = async || {
    let mut db = app.db.acquire().await?;
    let items = items_of(&mut db, &p.id, after).await?;
    Ok::<_, Refusal>(Received {
      items,
      received,
      read,
    })
  };
  let now = answer().await?;
  if !now.items.is_empty() || query.wait == Some(0) {
    return Ok(now);
  }
  let (tx, rx) = oneshot::channel();
  let key = change(app, &p.id, |inner| {
    let waiting = inner
      .receivers
      .values()
      .filter(|r| r.account == p.account)
      .count();
    if waiting >= MAX_WAITING {
      return Err(Refusal::busy(
        StatusCode::SERVICE_UNAVAILABLE,
        "This account has too many receives waiting.",
        10,
      ));
    }
    inner.next += 1;
    let key = inner.next;
    inner.receivers.insert(
      key,
      Receiver {
        account: p.account.clone(),
        participant: p.id.clone(),
        login: login.to_string(),
        held,
        end: tx,
      },
    );
    Ok(key)
  })?;
  let waiting = Waiting {
    app: app.clone(),
    key,
    p: p.clone(),
    held,
  };
  let timeout = async {
    match query.wait {
      Some(seconds) => tokio::time::sleep(Duration::from_secs(seconds)).await,
      None => std::future::pending().await,
    }
  };
  tokio::select! {
    ended = rx => if let Ok(Some(refusal)) = ended {
      return Err(refusal);
    },
    () = timeout => {}
  }
  drop(waiting);
  answer().await
}

#[derive(sqlx::FromRow)]
struct Stored {
  #[sqlx(rename = "type")]
  ty: String,
  filename: Option<String>,
  text: Option<String>,
  payload: Option<Vec<u8>>,
}

/// An entry's payload: its type, its file name, and its bytes.
pub async fn payload_of(
  db: &mut Db,
  session: &str,
  n: u64,
) -> Result<Option<(String, Option<String>, Vec<u8>)>> {
  let stored: Option<Stored> =
    sqlx::query_as("SELECT type, filename, text, payload FROM entry WHERE session = ? AND n = ?")
      .bind(session)
      .bind(n as i64)
      .fetch_optional(db)
      .await?;
  Ok(stored.map(|s| {
    let bytes = s
      .text
      .map(String::into_bytes)
      .or(s.payload)
      .unwrap_or_default();
    (s.ty, s.filename, bytes)
  }))
}
