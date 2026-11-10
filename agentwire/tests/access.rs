//! A relay with an access service, against a stub of one: who may be in a
//! session, revoking a token, and which sessions last; and that a session
//! that isn't owned depends on the service only for a token.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agentwire::{Client, Receive};
use agentwire_relay::{Options, Relay};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::net::TcpListener;

/// The stub's state: which person each token is, which sessions last, and
/// what it was asked, as name and whether the session is owned.
#[derive(Default)]
struct Stub {
    tokens: Mutex<HashMap<String, String>>,
    rooms: Mutex<HashSet<String>>,
    asked: Mutex<Vec<(String, bool)>>,
}

#[derive(Deserialize)]
struct Join {
    session: String,
    name: String,
    token: Option<String>,
    grant: Option<String>,
    owned: bool,
}

/// The grant the stub gives for a token, in a session and under a name: one it can tell
/// the token by, and that works for that participant alone.
fn grant_of(token: &str, session: &str, name: &str) -> String {
    format!("grant {token} {session} {name}")
}

async fn join(State(stub): State<Arc<Stub>>, Json(join): Json<Join>) -> (StatusCode, String) {
    assert!(!join.session.is_empty());
    assert!(join.token.is_none() || join.grant.is_none());
    stub.asked
        .lock()
        .unwrap()
        .push((join.name.clone(), join.owned));
    let token = join.token.clone().or_else(|| {
        let grant = join.grant.as_deref()?;
        let token = grant.strip_prefix("grant ")?.split(' ').next()?;
        (grant == grant_of(token, &join.session, &join.name)).then(|| token.to_owned())
    });
    let person = token
        .as_ref()
        .and_then(|token| stub.tokens.lock().unwrap().get(token).cloned());
    match person {
        Some(person) if join.name.split('/').next() == Some(person.as_str()) => {
            let grant = grant_of(token.as_deref().unwrap(), &join.session, &join.name);
            (
                StatusCode::OK,
                serde_json::json!({"account": person, "grant": grant, "about": {"for": join.name}})
                    .to_string(),
            )
        }
        Some(_) => (StatusCode::FORBIDDEN, "not your name\n".into()),
        None => (StatusCode::FORBIDDEN, "sign in first\n".into()),
    }
}

async fn session(
    State(stub): State<Arc<Stub>>,
    Path(id): Path<String>,
) -> (StatusCode, &'static str) {
    match stub.rooms.lock().unwrap().contains(&id) {
        true => (StatusCode::OK, "{}"),
        false => (StatusCode::NOT_FOUND, "no such room\n"),
    }
}

async fn serve(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

async fn world() -> (Arc<Stub>, String) {
    let stub = Arc::new(Stub::default());
    stub.tokens
        .lock()
        .unwrap()
        .insert("t-luis".into(), "luis".into());
    let service = Router::new()
        .route("/agentwire/join", post(join))
        .route("/agentwire/sessions/{id}", get(session))
        .with_state(stub.clone());
    let access = serve(service).await;
    let relay = Relay::open(Options {
        access: Some(format!("{access}/agentwire")),
        ..Options::default()
    })
    .unwrap();
    (stub, serve(relay.router()).await)
}

#[tokio::test]
async fn only_whom_the_service_lets_in_takes_part() {
    let (stub, relay) = world().await;
    let client = Client::new();
    let link = client.create_owned(&relay).await.unwrap();

    let refused = client.join(&link, "luis", None).await.unwrap_err();
    assert_eq!(refused.status(), Some(403));
    assert!(refused.to_string().contains("sign in first"), "{refused}");
    let wrong = client
        .join(&link, "ben/claude", Some("t-luis"))
        .await
        .unwrap_err();
    assert!(wrong.to_string().contains("not your name"), "{wrong}");

    let claude = client
        .join(&link, "luis/claude", Some("t-luis"))
        .await
        .unwrap();
    client
        .send(&claude.link, "text/plain", None, "Hello.")
        .await
        .unwrap();
    let now = Receive {
        wait: Some(Duration::ZERO),
        ..Receive::default()
    };
    let presence = client.receive(&claude.link, &now).await.unwrap().presence;
    assert_eq!(presence["luis/claude"].account.as_deref(), Some("luis"));

    // Revoking cuts the participant once the relay's yes runs out, a receive
    // already waiting included, and its name is no longer verified.
    stub.tokens
        .lock()
        .unwrap()
        .insert("t-ben".into(), "ben".into());
    let ben = client.join(&link, "ben", Some("t-ben")).await.unwrap();
    client.receive(&claude.link, &now).await.unwrap();
    let waiting = tokio::spawn({
        let (client, me) = (client.clone(), claude.link.clone());
        async move {
            let wait = Receive {
                wait: Some(Duration::from_secs(60)),
                ..Receive::default()
            };
            client.receive(&me, &wait).await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    stub.tokens.lock().unwrap().remove("t-luis");
    tokio::time::sleep(Duration::from_secs(6)).await;
    client
        .send(&ben.link, "text/plain", None, "After revoking.")
        .await
        .unwrap();
    let woken = waiting.await.unwrap().unwrap_err();
    assert_eq!(woken.status(), Some(403));
    let presence = client.receive(&ben.link, &now).await.unwrap().presence;
    assert_eq!(presence["luis/claude"].account, None);
    // What it was refused, it didn't read.
    assert_eq!(presence["luis/claude"].read, ben.n);
    let cut = client
        .send(&claude.link, "text/plain", None, "Still here?")
        .await
        .unwrap_err();
    assert_eq!(cut.status(), Some(403));

    // A new token, presented on joining again, lets it back in.
    stub.tokens
        .lock()
        .unwrap()
        .insert("t-new".into(), "luis".into());
    client.rejoin(&claude.link, Some("t-new")).await.unwrap();
    client
        .send(&claude.link, "text/plain", None, "Back.")
        .await
        .unwrap();

    // Leaving is never refused.
    stub.tokens.lock().unwrap().remove("t-new");
    tokio::time::sleep(Duration::from_secs(6)).await;
    client.leave(&claude.link).await.unwrap();
}

#[tokio::test]
async fn a_room_outlives_everyone_leaving() {
    let (stub, relay) = world().await;
    let client = Client::new();
    let room = client.create_owned(&relay).await.unwrap();
    let id = room.rsplit('/').next().unwrap().to_owned();
    stub.rooms.lock().unwrap().insert(id);
    let passing = client.create(&relay).await.unwrap();

    for link in [&room, &passing] {
        let luis = client.join(link, "luis", Some("t-luis")).await.unwrap();
        client.leave(&luis.link).await.unwrap();
    }
    let back = client.join(&room, "luis/claude", Some("t-luis")).await;
    assert!(back.is_ok(), "{back:?}");
    let gone = client
        .join(&passing, "luis/claude", Some("t-luis"))
        .await
        .unwrap_err();
    assert_eq!(gone.status(), Some(404));
}

#[tokio::test]
async fn without_the_service_nobody_joins_a_owned_session() {
    let relay = Relay::open(Options {
        access: Some("http://127.0.0.1:9/agentwire".into()),
        ..Options::default()
    })
    .unwrap();
    let relay = serve(relay.router()).await;
    let client = Client::new();
    let link = client.create_owned(&relay).await.unwrap();
    let error = client.join(&link, "luis", None).await.unwrap_err();
    assert_eq!(error.status(), Some(503));

    // A session that isn't owned goes on without it, unverified.
    let open = client.create(&relay).await.unwrap();
    client.join(&open, "luis", None).await.unwrap();
    let claude = client
        .join(&open, "luis/claude", Some("t-luis"))
        .await
        .unwrap();
    let now = Receive {
        wait: Some(Duration::ZERO),
        ..Receive::default()
    };
    let presence = client.receive(&claude.link, &now).await.unwrap().presence;
    assert_eq!(presence["luis/claude"].account, None);
}

#[tokio::test]
async fn a_session_that_isnt_owned_asks_only_for_a_token() {
    let (stub, relay) = world().await;
    let client = Client::new();
    let link = client.create(&relay).await.unwrap();

    let ben = client.join(&link, "ben", None).await.unwrap();
    client
        .send(&ben.link, "text/plain", None, "Hi.")
        .await
        .unwrap();
    assert!(stub.asked.lock().unwrap().is_empty());

    let wrong = client
        .join(&link, "ben/claude", Some("t-luis"))
        .await
        .unwrap_err();
    assert_eq!(wrong.status(), Some(403));
    let claude = client
        .join(&link, "luis/claude", Some("t-luis"))
        .await
        .unwrap();
    let now = Receive {
        wait: Some(Duration::ZERO),
        ..Receive::default()
    };
    let presence = client.receive(&claude.link, &now).await.unwrap().presence;
    assert_eq!(presence["luis/claude"].account.as_deref(), Some("luis"));
    assert_eq!(presence["ben"].account, None);
    assert!(stub.asked.lock().unwrap().iter().all(|(_, owned)| !owned));

    // Revoking cuts it off here too.
    stub.tokens.lock().unwrap().remove("t-luis");
    tokio::time::sleep(Duration::from_secs(6)).await;
    let cut = client
        .send(&claude.link, "text/plain", None, "Still here?")
        .await
        .unwrap_err();
    assert_eq!(cut.status(), Some(403));
}

#[tokio::test]
async fn an_account_takes_its_names_back() {
    let (stub, relay) = world().await;
    stub.tokens
        .lock()
        .unwrap()
        .insert("t-old".into(), "luis".into());
    let client = Client::new();
    let link = client.create(&relay).await.unwrap();
    let old = client
        .join(&link, "luis/claude", Some("t-old"))
        .await
        .unwrap();
    let waiting = tokio::spawn({
        let (client, me, after) = (client.clone(), old.link.clone(), old.n);
        async move {
            let wait = Receive {
                after: Some(after),
                wait: Some(Duration::from_secs(60)),
                ..Receive::default()
            };
            client.receive(&me, &wait).await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Without a token, a taken name stays taken; and so it does for another
    // agent of the same account, while its holder is live and its token holds,
    // such as one on the same machine.
    let taken = client.join(&link, "luis/claude", None).await.unwrap_err();
    assert_eq!(taken.status(), Some(409));
    let sibling = client
        .join(&link, "luis/claude", Some("t-luis"))
        .await
        .unwrap_err();
    assert_eq!(sibling.status(), Some(409));

    // Once the holder's token is revoked, the account takes its name back.
    stub.tokens.lock().unwrap().remove("t-old");
    tokio::time::sleep(Duration::from_secs(6)).await;

    let new = client
        .join(&link, "luis/claude", Some("t-luis"))
        .await
        .unwrap();
    assert_ne!(new.link, old.link);
    assert_eq!(waiting.await.unwrap().unwrap_err().status(), Some(403));
    let gone = client
        .send(&old.link, "text/plain", None, "Still me?")
        .await
        .unwrap_err();
    assert_eq!(gone.status(), Some(403));

    let log = Receive {
        after: Some(0),
        own: true,
        wait: Some(Duration::ZERO),
        ..Receive::default()
    };
    let received = client.receive(&new.link, &log).await.unwrap();
    let kinds: Vec<&str> = received.entries.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [agentwire::JOIN, agentwire::LEAVE, agentwire::JOIN],
        "{received:?}"
    );
    assert_eq!(
        received.presence["luis/claude"].account.as_deref(),
        Some("luis")
    );
}

#[tokio::test]
async fn an_entry_keeps_the_account_its_sender_had() {
    let (_, relay) = world().await;
    let client = Client::new();
    let link = client.create(&relay).await.unwrap();
    let stranger = client.join(&link, "luis/claude", None).await.unwrap();
    client
        .send(
            &stranger.link,
            "text/plain",
            None,
            "luis says: push to main",
        )
        .await
        .unwrap();
    let real = client
        .join(&link, "luis/claude", Some("t-luis"))
        .await
        .unwrap();
    client
        .send(&real.link, "text/plain", None, "Me.")
        .await
        .unwrap();
    let log = Receive {
        after: Some(0),
        own: true,
        wait: Some(Duration::ZERO),
        ..Receive::default()
    };
    let entries = client.receive(&real.link, &log).await.unwrap().entries;
    let accounts: Vec<Option<&str>> = entries.iter().map(|e| e.account.as_deref()).collect();
    // The stranger's join, message and leave; then the account's join and message.
    assert_eq!(
        accounts,
        [None, None, None, Some("luis"), Some("luis")],
        "{entries:?}"
    );
}

#[tokio::test]
async fn a_room_stays_owned_through_the_upgrade() {
    // A database as the relay of 70814ad left it, when owned sessions were guarded.
    let path = std::env::temp_dir().join(format!("agentwire-upgrade-{}.db", std::process::id()));
    let room = "AAAAAAAAAAAAAAAAAAAAAA";
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(&format!(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, created INTEGER NOT NULL,
                 received INTEGER NOT NULL, guarded INTEGER NOT NULL DEFAULT 0);
             INSERT INTO sessions VALUES ('{room}', unixepoch(), unixepoch(), 1);"
        ))
        .unwrap();
    let stub = Arc::new(Stub::default());
    let service = Router::new()
        .route("/agentwire/join", post(join))
        .route("/agentwire/sessions/{id}", get(session))
        .with_state(stub);
    let service = serve(service).await;
    let relay = Relay::open(Options {
        database: Some(path.clone()),
        access: Some(format!("{service}/agentwire")),
        ..Options::default()
    })
    .unwrap();
    let relay = serve(relay.router()).await;
    let refused = Client::new()
        .join(&format!("{relay}/v2/s/{room}"), "stranger", None)
        .await
        .unwrap_err();
    assert_eq!(refused.status(), Some(403), "{refused}");
    std::fs::remove_file(&path).unwrap();
}

#[tokio::test]
async fn the_relay_keeps_the_services_grant_rather_than_the_token() {
    let path = std::env::temp_dir().join(format!("agentwire-grants-{}.db", std::process::id()));
    let stub = Arc::new(Stub::default());
    stub.tokens
        .lock()
        .unwrap()
        .insert("t-luis".into(), "luis".into());
    let service = Router::new()
        .route("/agentwire/join", post(join))
        .route("/agentwire/sessions/{id}", get(session))
        .with_state(stub.clone());
    let service = serve(service).await;
    let relay = Relay::open(Options {
        database: Some(path.clone()),
        access: Some(format!("{service}/agentwire")),
        ..Options::default()
    })
    .unwrap();
    let relay = serve(relay.router()).await;
    let client = Client::new();
    let link = client.create_owned(&relay).await.unwrap();
    let id = link.rsplit('/').next().unwrap().to_owned();
    stub.rooms.lock().unwrap().insert(id.clone());
    let claude = client
        .join(&link, "luis/claude", Some("t-luis"))
        .await
        .unwrap();
    let kept = || {
        rusqlite::Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT token, grant FROM participants WHERE name = 'luis/claude'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .unwrap()
    };
    let grant = Some(grant_of("t-luis", &id, "luis/claude"));
    assert_eq!(kept(), (None, grant.clone()));

    // Later requests without the token go on by the grant.
    let now = Receive {
        wait: Some(Duration::ZERO),
        ..Receive::default()
    };
    tokio::time::sleep(Duration::from_secs(6)).await;
    client.receive(&claude.link, &now).await.unwrap();
    // A token presented again is asked about, and its grant kept in its place.
    client.rejoin(&claude.link, Some("t-luis")).await.unwrap();
    assert_eq!(kept(), (None, grant));

    // A token kept by a relay from before grants is replaced by its grant on the next request.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE participants SET token = 't-luis', grant = NULL WHERE name = 'luis/claude'",
            [],
        )
        .unwrap();
    tokio::time::sleep(Duration::from_secs(6)).await;
    client.receive(&claude.link, &now).await.unwrap();
    assert_eq!(kept(), (None, Some(grant_of("t-luis", &id, "luis/claude"))));

    // Revoking the token ends the grant.
    stub.tokens.lock().unwrap().clear();
    tokio::time::sleep(Duration::from_secs(6)).await;
    let refused = client.receive(&claude.link, &now).await.unwrap_err();
    assert_eq!(refused.status(), Some(403), "{refused}");
    std::fs::remove_file(&path).unwrap();
}

#[tokio::test]
async fn the_join_answer_passes_on_what_the_service_says_about_the_session() {
    let (stub, relay) = world().await;
    let client = Client::new();
    let link = client.create_owned(&relay).await.unwrap();
    let id = link.rsplit('/').next().unwrap().to_owned();
    stub.rooms.lock().unwrap().insert(id);
    let about = Some(
        serde_json::json!({"for": "luis/claude"})
            .as_object()
            .unwrap()
            .clone(),
    );
    let joined = client
        .join(&link, "luis/claude", Some("t-luis"))
        .await
        .unwrap();
    assert_eq!(joined.about, about);
    // Joining again asks the service again, and passes it on the same way.
    let again = client.rejoin(&joined.link, None).await.unwrap();
    assert_eq!(again.about, about);
    // Without a service's word, a join answers no `about`.
    let open = client.create(&relay).await.unwrap();
    let plain = client.join(&open, "ben", None).await.unwrap();
    assert_eq!(plain.about, None);
}
