//! The migrations, each on a database of the schema before it.

mod common;

use common::*;
use sqlx::{Connection, SqliteConnection};
use vibetogether_protocol::{LoginKind, OverviewQuery};

/// Agents become members: each of its person's own group, and, unless archived, of every group
/// of a session it took part in, where its person still is; none stays in a DM.
#[tokio::test]
async fn agents_become_members_of_the_groups_they_worked_in() {
  let database = scratch().join("backend.db");
  let mut db = SqliteConnection::connect(&format!("sqlite:{}?mode=rwc", database.display()))
    .await
    .unwrap();
  sqlx::migrate!().run_to(2, &mut db).await.unwrap();
  sqlx::raw_sql(
    r#"
    INSERT INTO account VALUES ('u_luis', 1, 'luis', 'Luis', NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO account VALUES ('u_ben', 2, 'ben', 'Ben', NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO "group" VALUES ('g_luis', 'luis', 'u_luis', '2026-11-01T00:00:00.000Z');
    INSERT INTO "group" VALUES ('g_ben', 'ben', 'u_ben', '2026-11-01T00:00:00.000Z');
    INSERT INTO "group" VALUES ('g_ph', 'Potential Hedge', NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO "group" VALUES ('g_left', 'Left', NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO group_member VALUES ('g_luis', 'u_luis'), ('g_ben', 'u_ben'),
      ('g_ph', 'u_luis'), ('g_ph', 'u_ben'), ('g_left', 'u_ben');
    INSERT INTO project VALUES ('p_vt', 'vibetogether', 'g_ph', '2026-11-01T00:00:00.000Z');
    INSERT INTO session VALUES ('s_build', 'build', 'p_vt', 'u_luis', '2026-11-01T00:00:00.000Z');
    INSERT INTO session VALUES ('s_gone', 'gone', NULL, 'u_ben', '2026-11-01T00:00:00.000Z');
    INSERT INTO group_session VALUES ('s_gone', 'g_left', 0);
    INSERT INTO session VALUES ('s_dm', 'DM', NULL, NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO dm VALUES ('u_ben', 'u_luis', 's_dm');
    INSERT INTO friend VALUES ('u_luis', 'u_ben', '2026-11-01T00:00:00.000Z'),
      ('u_ben', 'u_luis', '2026-11-01T00:00:00.000Z');
    INSERT INTO agent VALUES ('a_lead', 'u_luis', 'lead', NULL, NULL, NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO agent VALUES ('a_idle', 'u_luis', 'idle', NULL, NULL, NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO agent VALUES ('a_old', 'u_luis', 'old', NULL, NULL, '2026-11-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    INSERT INTO agent VALUES ('a_left', 'u_luis', 'left', NULL, NULL, NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO participant VALUES ('s_build', 'a_lead', 'u_luis', 1, 1, 0, 0, '2026-11-01T00:00:00.000Z', 'all');
    INSERT INTO participant VALUES ('s_build', 'a_old', 'u_luis', 0, 1, 0, 0, '2026-11-01T00:00:00.000Z', 'all');
    INSERT INTO participant VALUES ('s_build', 'a_idle', 'u_luis', 0, 1, 0, 0, '2026-11-01T00:00:00.000Z', 'all');
    INSERT INTO participant VALUES ('s_dm', 'a_lead', 'u_luis', 1, 1, 0, 0, '2026-11-01T00:00:00.000Z', 'all');
    INSERT INTO participant VALUES ('s_gone', 'a_left', 'u_luis', 1, 1, 0, 0, '2026-11-01T00:00:00.000Z', 'all');
    "#,
  )
  .execute(&mut db)
  .await
  .unwrap();
  db.close().await.unwrap();

  let server = server_on(database).await;
  let mut db = server.db().await;
  let mut members: Vec<(String, String)> =
    sqlx::query_as(r#"SELECT "group", member FROM group_member WHERE member LIKE 'a_%'"#)
      .fetch_all(&mut db)
      .await
      .unwrap();
  members.sort();
  let pairs = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
    pairs.iter().map(|(g, m)| (s(g), s(m))).collect()
  };
  assert_eq!(
    members,
    pairs(&[
      ("g_luis", "a_idle"),
      ("g_luis", "a_lead"),
      ("g_luis", "a_left"),
      ("g_luis", "a_old"),
      ("g_ph", "a_lead"),
    ])
  );
  let inside: bool =
    sqlx::query_scalar("SELECT inside FROM participant WHERE session = 's_dm' AND id = 'a_lead'")
      .fetch_one(&mut db)
      .await
      .unwrap();
  assert!(!inside);
  // Luis left the group Left before leaving took his agent out of its sessions: now it is out.
  let inside: bool =
    sqlx::query_scalar("SELECT inside FROM participant WHERE session = 's_gone' AND id = 'a_left'")
      .fetch_one(&mut db)
      .await
      .unwrap();
  assert!(!inside);

  // Ben sees Luis's agent that worked in their group, and no other.
  let ben = server.token("u_ben", LoginKind::Person, "ben").await;
  let overview = ben.overview(&OverviewQuery::default()).await.unwrap();
  let ph = overview
    .groups
    .iter()
    .find(|g| g.group.id == "g_ph")
    .unwrap();
  let agents: Vec<&str> = ph.group.agents.iter().map(|a| a.name.as_str()).collect();
  assert_eq!(agents, ["luis/lead"]);
  assert_eq!(ph.group.members, [s("ben"), s("luis")]);
}

/// Apps: the logins stay as they were, now allowed to be apps too, and entries name no app.
#[tokio::test]
async fn logins_and_entries_stay_as_logins_may_be_apps() {
  let database = scratch().join("backend.db");
  let mut db = SqliteConnection::connect(&format!("sqlite:{}?mode=rwc", database.display()))
    .await
    .unwrap();
  sqlx::migrate!().run_to(3, &mut db).await.unwrap();
  sqlx::raw_sql(
    r#"
    INSERT INTO account VALUES ('u_luis', 1, 'luis', 'Luis', NULL, '2026-11-01T00:00:00.000Z');
    INSERT INTO login VALUES ('l_1', 'u_luis', 'person', 'phone', 'hash', '2026-11-01T00:00:00.000Z', NULL);
    INSERT INTO session VALUES ('s_1', 'one', NULL, 'u_luis', '2026-11-01T00:00:00.000Z');
    INSERT INTO entry VALUES ('s_1', 1, '2026-11-01T00:00:00Z', 'luis', 'u_luis', 'text/plain', 2, NULL, 'hi', NULL);
    "#,
  )
  .execute(&mut db)
  .await
  .unwrap();
  db.close().await.unwrap();

  let server = server_on(database).await;
  let mut db = server.db().await;
  let login: (String, String) = sqlx::query_as("SELECT kind, name FROM login WHERE id = 'l_1'")
    .fetch_one(&mut db)
    .await
    .unwrap();
  assert_eq!(login, (s("person"), s("phone")));
  let app: Option<String> = sqlx::query_scalar("SELECT app FROM entry WHERE session = 's_1'")
    .fetch_one(&mut db)
    .await
    .unwrap();
  assert_eq!(app, None);
  let app = server.token("u_luis", LoginKind::App, "agentvoice").await;
  assert_eq!(app.me().await.unwrap().name, "luis");
}

/// The trash is purged, as the backend starts and every hour, of what was deleted 30 days ago,
/// with everything in it; what was deleted since stays.
#[tokio::test]
async fn the_trash_is_purged_after_30_days() {
  let database = scratch().join("backend.db");
  let mut db = SqliteConnection::connect(&format!("sqlite:{}?mode=rwc", database.display()))
    .await
    .unwrap();
  sqlx::migrate!().run(&mut db).await.unwrap();
  sqlx::raw_sql(
    r#"
    INSERT INTO account VALUES ('u_luis', 1, 'luis', 'Luis', NULL, '2026-01-01T00:00:00.000Z');
    INSERT INTO "group" (id, name, person, created) VALUES ('g_luis', 'luis', 'u_luis', '2026-01-01T00:00:00.000Z');
    INSERT INTO "group" (id, name, created, trashed) VALUES
      ('g_old', 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('g_new', 'new', '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z');
    INSERT INTO group_member VALUES ('g_old', 'u_luis', 'u_luis'), ('g_new', 'u_luis', 'u_luis');
    INSERT INTO project (id, name, "group", created) VALUES ('p_in', 'in', 'g_old', '2026-01-01T00:00:00.000Z');
    INSERT INTO session (id, name, project, created) VALUES ('s_in', 'in', 'p_in', '2026-01-01T00:00:00.000Z');
    INSERT INTO entry (session, n, time, sender, type, size, text) VALUES ('s_in', 1, '2026-01-01T00:00:00.000Z', 'luis', 'text/plain', 2, 'hi');
    INSERT INTO agent (id, account, name, trashed, created) VALUES
      ('a_old', 'u_luis', 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('a_new', 'u_luis', 'new', '2999-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO group_member VALUES ('g_luis', 'a_old', 'u_luis'), ('g_luis', 'a_new', 'u_luis');
    "#,
  )
  .execute(&mut db)
  .await
  .unwrap();
  db.close().await.unwrap();

  let server = server_on(database).await;
  sleep(200).await;
  let mut db = server.db().await;
  let left = |sql: &'static str| sqlx::query_scalar::<_, String>(sql);
  assert_eq!(
    left(r#"SELECT id FROM "group" ORDER BY id"#)
      .fetch_all(&mut db)
      .await
      .unwrap(),
    ["g_luis", "g_new"]
  );
  assert!(
    left("SELECT id FROM session")
      .fetch_all(&mut db)
      .await
      .unwrap()
      .is_empty()
  );
  assert_eq!(
    left("SELECT id FROM agent")
      .fetch_all(&mut db)
      .await
      .unwrap(),
    ["a_new"]
  );
  assert_eq!(
    left("SELECT member FROM group_member WHERE member LIKE 'a_%'")
      .fetch_all(&mut db)
      .await
      .unwrap(),
    ["a_new"]
  );
}
