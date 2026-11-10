//! Signing in, lazily, against a stub of the account service that is also the relay's
//! access service: everything works without an account but joining a session, which is
//! challenged, and a token is passed on, so that its name shows as verified.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use agentwire::Client;
use agentwire_relay::{Options, Relay};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation,
    ProtocolVersion,
};
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{ClientLifecycleMode, ClientServiceExt, RoleClient, object};
use serde::Deserialize;
use tokio::net::TcpListener;
use vibetogether_mcp::{Accounts, Server, router};

const RESOURCE: &str = "https://vibetogether.example/mcp";
const METADATA: &str = "https://vibetogether.example/.well-known/oauth-protected-resource/mcp";

/// The sessions, by session token; the one account is `luis`, whose token is `t-luis`.
#[derive(Default)]
struct Stub {
    sessions: Mutex<HashSet<String>>,
    /// The sessions open to anyone with their address.
    open: Mutex<HashSet<String>>,
    /// The project file of `p_1`: its version and its text.
    file: Mutex<(u64, String)>,
}

async fn me(headers: HeaderMap) -> (StatusCode, String) {
    match headers.get("authorization").and_then(|v| v.to_str().ok()) {
        Some("Bearer t-luis") => (StatusCode::OK, r#"{"name":"luis"}"#.into()),
        _ => (StatusCode::UNAUTHORIZED, String::new()),
    }
}

/// What the service answers `luis` alone.
fn for_luis(headers: &HeaderMap, answer: &str) -> (StatusCode, String) {
    match headers.get("authorization").and_then(|v| v.to_str().ok()) {
        Some("Bearer t-luis") => (StatusCode::OK, answer.into()),
        _ => (StatusCode::UNAUTHORIZED, String::new()),
    }
}

async fn groups(headers: HeaderMap) -> (StatusCode, String) {
    for_luis(
        &headers,
        r#"[{"id":"g_1","name":"luis","own":true,"owner":"luis","members":[]},{"id":"g_2","name":"Potential Hedge","own":false,"owner":"luis","members":["ben"]}]"#,
    )
}

async fn projects(headers: HeaderMap) -> (StatusCode, String) {
    for_luis(
        &headers,
        r#"[{"id":"p_1","name":"vibetogether","group":{"id":"g_2","name":"Potential Hedge"},"app":null,"file":null},{"id":"p_2","name":"messagent","group":{"id":"g_1","name":"luis"},"app":"messagent","file":null}]"#,
    )
}

async fn sessions(headers: HeaderMap) -> (StatusCode, String) {
    for_luis(
        &headers,
        r#"[{"id":"s_1","name":"agents","project":{"id":"p_1","name":"vibetogether"},"group":{"id":"g_2","name":"Potential Hedge"},"open":"members","address":"L","app":null},{"id":"s_2","name":"Telegram","project":{"id":"p_2","name":"messagent"},"group":{"id":"g_1","name":"luis"},"open":"members","address":"T","app":{"id":"a_1","name":"messagent"}}]"#,
    )
}

async fn read_file(
    State(stub): State<Arc<Stub>>,
    Path(project): Path<String>,
    headers: HeaderMap,
) -> (StatusCode, String) {
    if project != "p_1" {
        return (StatusCode::NOT_FOUND, "No such project.".into());
    }
    let (version, text) = stub.file.lock().unwrap().clone();
    let file = serde_json::json!({"version": version, "text": text, "by": "luis"});
    for_luis(&headers, &file.to_string())
}

#[derive(Deserialize)]
struct Write {
    text: String,
    replaces: u64,
}

async fn write_file(
    State(stub): State<Arc<Stub>>,
    Path(project): Path<String>,
    headers: HeaderMap,
    Json(write): Json<Write>,
) -> (StatusCode, String) {
    if for_luis(&headers, "").0 != StatusCode::OK || project != "p_1" {
        return (StatusCode::NOT_FOUND, "No such project.".into());
    }
    let mut file = stub.file.lock().unwrap();
    if write.replaces != file.0 {
        return (
            StatusCode::CONFLICT,
            format!("The file is at version {} now.", file.0),
        );
    }
    *file = (file.0 + 1, write.text);
    (
        StatusCode::OK,
        serde_json::json!({"version": file.0, "by": "luis"}).to_string(),
    )
}

#[derive(Deserialize)]
struct Join {
    session: String,
    name: String,
    token: Option<String>,
    owned: bool,
}

async fn join(State(stub): State<Arc<Stub>>, Json(join): Json<Join>) -> (StatusCode, String) {
    let session = stub.sessions.lock().unwrap().contains(&join.session);
    let open = stub.open.lock().unwrap().contains(&join.session);
    match join.token.as_deref() {
        Some("t-luis") if join.name.split('/').next() == Some("luis") => {
            (StatusCode::OK, r#"{"account":"luis"}"#.into())
        }
        Some(_) => (StatusCode::FORBIDDEN, "not your name\n".into()),
        None if (join.owned && !open) || session => {
            (StatusCode::FORBIDDEN, "sign in first\n".into())
        }
        None => (StatusCode::OK, r#"{"account":null}"#.into()),
    }
}

async fn session(
    State(stub): State<Arc<Stub>>,
    Path(id): Path<String>,
) -> (StatusCode, &'static str) {
    let known =
        stub.sessions.lock().unwrap().contains(&id) || stub.open.lock().unwrap().contains(&id);
    match known {
        true => (StatusCode::OK, "{}"),
        false => (StatusCode::NOT_FOUND, "no such session\n"),
    }
}

async fn serve(router: axum::Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

/// The server, signed in to the stub, with a session and a session by secret link.
struct World {
    mcp: String,
    session: String,
    /// A session an account owns that is open to anyone with its address.
    shared: String,
    open: String,
}

async fn world() -> World {
    let stub = Arc::new(Stub::default());
    let service = serve(
        axum::Router::new()
            .route("/api/me", get(me))
            .route("/api/groups", get(groups))
            .route("/api/projects", get(projects))
            .route("/api/sessions", get(sessions))
            .route("/api/projects/{id}/file", get(read_file).put(write_file))
            .route("/agentwire/join", post(join))
            .route("/agentwire/sessions/{id}", get(session))
            .with_state(stub.clone()),
    )
    .await;
    let relay = Relay::open(Options {
        access: Some(format!("{service}/agentwire")),
        ..Options::default()
    })
    .unwrap();
    let relay = serve(relay.router()).await;
    let accounts = Accounts::new(&service, RESOURCE).unwrap();
    let mcp = serve(router(Server::new(&relay), ["127.0.0.1"], Some(accounts))).await;
    let client = Client::new();
    let session = client.create_owned(&relay).await.unwrap();
    let id = session.rsplit('/').next().unwrap().to_owned();
    stub.sessions.lock().unwrap().insert(id);
    let shared = client.create_owned(&relay).await.unwrap();
    let id = shared.rsplit('/').next().unwrap().to_owned();
    stub.open.lock().unwrap().insert(id);
    let open = client.create(&relay).await.unwrap();
    World {
        mcp: format!("{mcp}/mcp"),
        session,
        shared,
        open,
    }
}

/// A client of the server, with `token` as its bearer.
async fn client(mcp: &str, token: Option<&str>) -> RunningService<RoleClient, ClientConfig> {
    let mut config = StreamableHttpClientTransportConfig::with_uri(mcp.to_owned());
    if let Some(token) = token {
        config = config.auth_header(token);
    }
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("test", "0"),
    )
    .serve_with_lifecycle(
        StreamableHttpClientTransport::from_config(config),
        ClientLifecycleMode::Auto {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            legacy_version: Some(ProtocolVersion::V_2025_11_25),
        },
    )
    .await
    .unwrap()
}

async fn join_as(
    client: &RunningService<RoleClient, ClientConfig>,
    session: &str,
    name: &str,
) -> CallToolResult {
    client
        .call_tool(
            CallToolRequestParams::new("join")
                .with_arguments(object!({ "session": session, "name": name })),
        )
        .await
        .unwrap()
}

fn text(result: &CallToolResult) -> String {
    result.content[0].as_text().unwrap().text.clone()
}

/// What the server answers a plain `join` call, with `token` as the bearer.
async fn post_join(mcp: &str, session: &str, token: Option<&str>) -> reqwest::Response {
    let call = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "join", "arguments": {"session": session, "name": "luis/claude"}},
    });
    let mut request = reqwest::Client::new()
        .post(mcp)
        .header("accept", "application/json, text/event-stream")
        .json(&call);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    request.send().await.unwrap()
}

#[tokio::test]
async fn without_an_account_a_session_by_secret_link_works() {
    let world = world().await;
    let client = client(&world.mcp, None).await;
    let joined = join_as(&client, &world.open, "luis/claude").await;
    assert_ne!(joined.is_error, Some(true), "{joined:?}");
    let text = text(&joined);
    assert!(
        text.contains(r#"{"name":"luis/claude","you":true,"verified":false,"listening":false}"#),
        "{text}"
    );
}

#[tokio::test]
async fn joining_a_room_without_a_token_is_challenged() {
    let world = world().await;
    let answer = post_join(&world.mcp, &world.session, None).await;
    assert_eq!(answer.status(), 401);
    let challenge = answer.headers()["www-authenticate"].to_str().unwrap();
    assert_eq!(
        challenge,
        format!(r#"Bearer resource_metadata="{METADATA}""#)
    );
    // A session named by its token alone, too.
    let id = world.session.rsplit('/').next().unwrap();
    assert_eq!(post_join(&world.mcp, id, None).await.status(), 401);
    // The session by secret link is no session.
    assert_ne!(post_join(&world.mcp, &world.open, None).await.status(), 401);
}

#[tokio::test]
async fn a_token_the_service_rejects_is_challenged() {
    let world = world().await;
    let answer = post_join(&world.mcp, &world.open, Some("t-ben")).await;
    assert_eq!(answer.status(), 401);
    let challenge = answer.headers()["www-authenticate"].to_str().unwrap();
    assert_eq!(
        challenge,
        format!(r#"Bearer resource_metadata="{METADATA}", error="invalid_token""#)
    );
}

#[tokio::test]
async fn an_agent_joins_with_its_token_and_shows_as_verified() {
    let world = world().await;
    let client = client(&world.mcp, Some("t-luis")).await;
    for session in [&world.session, &world.open] {
        let joined = join_as(&client, session, "luis/claude").await;
        assert_ne!(joined.is_error, Some(true), "{joined:?}");
        let text = text(&joined);
        assert!(
            text.contains(r#""name":"luis/claude","you":true,"verified":true"#),
            "{text}"
        );
    }
    let refused = join_as(&client, &world.open, "ben/claude").await;
    assert_eq!(refused.is_error, Some(true));
    assert!(text(&refused).contains("not your name"), "{refused:?}");
}

#[tokio::test]
async fn listing_the_rooms_asks_to_sign_in_first() {
    let world = world().await;
    let call = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "sessions", "arguments": {}},
    });
    let answer = reqwest::Client::new()
        .post(&world.mcp)
        .header("accept", "application/json, text/event-stream")
        .json(&call)
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), 401);

    let client = client(&world.mcp, Some("t-luis")).await;
    let listed = client
        .call_tool(CallToolRequestParams::new("sessions"))
        .await
        .unwrap();
    assert_eq!(
        text(&listed),
        r#"{"groups":[{"id":"g_1","name":"luis","own":true,"owner":"luis","members":[],"projects":[{"id":"p_2","name":"messagent","app":"messagent","file":null,"sessions":[{"id":"s_2","name":"Telegram","address":"T","open":"members","app":"messagent"}]}]},{"id":"g_2","name":"Potential Hedge","own":false,"owner":"luis","members":["ben"],"projects":[{"id":"p_1","name":"vibetogether","app":null,"file":null,"sessions":[{"id":"s_1","name":"agents","address":"L","open":"members","app":null}]}]}]}"#
    );
}

#[tokio::test]
async fn the_project_file_is_read_and_written_over_the_version_read() {
    let world = world().await;
    for tool in ["project_file", "write_project_file"] {
        let call = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": {"project": "p_1", "text": "x", "replaces": 0}},
        });
        let answer = reqwest::Client::new()
            .post(&world.mcp)
            .header("accept", "application/json, text/event-stream")
            .json(&call)
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status(), 401, "{tool}");
    }

    let client = client(&world.mcp, Some("t-luis")).await;
    let call = |tool: &'static str, arguments| {
        let client = &client;
        async move {
            client
                .call_tool(CallToolRequestParams::new(tool).with_arguments(arguments))
                .await
                .unwrap()
        }
    };
    let read = call("project_file", object!({"project": "p_1"})).await;
    let read: serde_json::Value = serde_json::from_str(&text(&read)).unwrap();
    assert!(read["about"].as_str().unwrap().contains("not orders"));
    assert_eq!(read["file"]["version"], 0);
    let written = call(
        "write_project_file",
        object!({"project": "p_1", "text": "# Plan", "replaces": 0}),
    )
    .await;
    assert_ne!(written.is_error, Some(true), "{written:?}");
    let stale = call(
        "write_project_file",
        object!({"project": "p_1", "text": "mine", "replaces": 0}),
    )
    .await;
    assert_eq!(stale.is_error, Some(true));
    assert!(text(&stale).contains("version 1"), "{stale:?}");
    let read = call("project_file", object!({"project": "p_1"})).await;
    assert!(text(&read).contains("# Plan"));
    // No argument names another path of the service.
    let elsewhere = call("project_file", object!({"project": "p_1/../../me"})).await;
    assert_eq!(elsewhere.is_error, Some(true));
}

#[tokio::test]
async fn a_room_open_by_its_address_needs_no_account() {
    let world = world().await;
    assert_ne!(
        post_join(&world.mcp, &world.shared, None).await.status(),
        401
    );
    let client = client(&world.mcp, None).await;
    let joined = join_as(&client, &world.shared, "ben/claude").await;
    assert_ne!(joined.is_error, Some(true), "{joined:?}");
}
