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
    INSERT INTO participant VALUES ('s_build', 'a_lead', 'u_luis', 0, 1, 0, 0, '2026-11-01T00:00:00.000Z', 'all');
    INSERT INTO participant VALUES ('s_build', 'a_old', 'u_luis', 0, 1, 0, 0, '2026-11-01T00:00:00.000Z', 'all');
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
