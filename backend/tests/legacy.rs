//! The import from the TypeScript backend's database, on a copy made from its schema
//! (`legacy.sql`, dumped from a database the TypeScript backend made): two people signed up with
//! GitHub, a sign-in and a machine's token each, an expired token, and some state of Vibe
//! Together's own.

mod common;

use common::*;
use sqlx::{Connection, SqliteConnection};
use vibetogether_client::Client;
use vibetogether_protocol::{LoginKind, OverviewQuery};

#[tokio::test]
async fn the_accounts_and_machines_tokens_come_over_once() {
  let dir = scratch();
  let database = dir.join("backend.db");
  let mut legacy = SqliteConnection::connect(&format!("sqlite:{}?mode=rwc", database.display()))
    .await
    .unwrap();
  sqlx::raw_sql(sqlx::AssertSqlSafe(include_str!("legacy.sql")))
    .execute(&mut legacy)
    .await
    .unwrap();
  legacy.close().await.unwrap();

  let server = server_on(database.clone()).await;
  assert!(!dir.join("backend-legacy.db").exists());
  assert!(dir.join("backend-legacy-imported.db").exists());

  // A machine's token is an agent token of the same account now.
  let token = Client::new(&server.url, Some("AGDek2NG0aCyeRhK2TqlaSC58sWnEQ1F".into()));
  let claude = token.create_agent("claude").await.unwrap();
  let luis = token.clone().acting_as(Some(claude.id));
  let me = luis.me().await.unwrap();
  assert_eq!(
    (me.name.as_str(), me.display_name.as_str()),
    ("luis", "Luis Wirth")
  );
  assert_eq!(
    me.image.as_deref(),
    Some("https://avatars.githubusercontent.com/u/1001")
  );
  let logins = luis.logins().await.unwrap();
  assert_eq!(logins.len(), 1);
  assert_eq!(
    (logins[0].name.as_str(), logins[0].kind, logins[0].current),
    ("luis-dev", LoginKind::Agent, true)
  );
  let session = luis
    .overview(&OverviewQuery::default())
    .await
    .unwrap()
    .groups[0]
    .sessions[0]
    .id
    .clone();
  assert_eq!(status(token.join(&session).await), 400);
  assert_eq!(status(luis.join(&session).await), 200);

  // Vibe Together's own state starts empty: each account has its own group alone.
  let overview = luis.overview(&OverviewQuery::default()).await.unwrap();
  assert_eq!(overview.groups.len(), 1);
  assert!(overview.groups[0].group.own && overview.groups[0].group.name == "luis");
  assert_eq!(overview.agents.len(), 1);

  // Ben's token comes over, his expired one and every browser's sign-in not.
  let ben = Client::new(&server.url, Some("rJfmpSNATlAQ2TbEKKv2R8Tz3kZRykaX".into()));
  let scout = ben.create_agent("scout").await.unwrap();
  let ben = ben.acting_as(Some(scout.id));
  assert_eq!(ben.me().await.unwrap().name, "ben");
  assert_eq!(
    status(
      Client::new(&server.url, Some("expiredtoken".into()))
        .me()
        .await
    ),
    401
  );
  assert_eq!(
    status(
      Client::new(&server.url, Some("pHv8UOJruhnH60k4ODn8kD27ECqo4HER".into()))
        .me()
        .await
    ),
    401
  );

  // Signing in with GitHub again finds the same account, by its GitHub id.
  assert_eq!(
    server
      .app
      .sign_up(1001, "luis", "Luis Wirth", None)
      .await
      .unwrap(),
    me.id
  );

  // A restart imports nothing again: a token revoked stays revoked.
  let ben_login = ben.logins().await.unwrap()[0].id.clone();
  ben.revoke_login(&ben_login).await.unwrap();
  let again = server_on(database).await;
  assert_eq!(
    status(
      Client::new(&again.url, Some("rJfmpSNATlAQ2TbEKKv2R8Tz3kZRykaX".into()))
        .me()
        .await
    ),
    401
  );
  let accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM account")
    .fetch_one(&mut again.db().await)
    .await
    .unwrap();
  assert_eq!(accounts, 2);
}
