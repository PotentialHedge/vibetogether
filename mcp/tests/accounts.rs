//! Signing in against a stub of the account service that is also the relay's access service:
//! nothing works without an account, a token is passed on, so that its name shows as verified,
//! and only the service's sessions are joined.

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

/// A document of three operations: two a token may call, and one for the browser alone.
async fn document() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "openapi": "3.1.0",
        "tags": [{"name": "Sessions", "description": "Every session is one of a project's."}],
        "components": {"schemas": {"Name": {"type": "string", "description": "A name."}}},
        "paths": {
            "/sessions": {"get": {
                "operationId": "list_sessions", "summary": "List the sessions",
                "description": "The sessions of the caller's groups.",
                "security": [{"token": []}, {"browser": []}],
            }},
            "/sessions/{id}": {"patch": {
                "operationId": "rename_session", "summary": "Rename a session",
                "description": "Renames a session.",
                "security": [{"token": []}, {"browser": []}],
                "parameters": [{"in": "path", "name": "id", "required": true, "schema": {"type": "string"}}],
                "requestBody": {"content": {"application/json": {"schema": {
                    "type": "object", "properties": {"name": {"$ref": "#/components/schemas/Name"}}, "required": ["name"],
                }}}},
            }},
            "/me": {"delete": {
                "operationId": "delete_account", "description": "Deletes the account.",
                "security": [{"browser": []}],
            }},
        },
    }))
}

async fn sessions(headers: HeaderMap) -> (StatusCode, String) {
    for_luis(&headers, r#"[{"id":"s_1","name":"agents"}]"#)
}

async fn rename(
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, String) {
    for_luis(
        &headers,
        &format!(r#"{{"id":{id:?},"name":{}}}"#, body["name"]),
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
    match join.token.as_deref() {
        Some("t-luis") if join.name.split('/').next() == Some("luis") => {
            let about = if session {
                r#","about":{"project":"vibetogether","repos":["https://github.com/PotentialHedge/vibetogether"]}"#
            } else {
                ""
            };
            (StatusCode::OK, format!(r#"{{"account":"luis"{about}}}"#))
        }
        Some(_) => (StatusCode::FORBIDDEN, "not your name\n".into()),
        None if join.owned || session => (StatusCode::FORBIDDEN, "sign in first\n".into()),
        None => (StatusCode::OK, r#"{"account":null}"#.into()),
    }
}

async fn session(
    State(stub): State<Arc<Stub>>,
    Path(id): Path<String>,
) -> (StatusCode, &'static str) {
    match stub.sessions.lock().unwrap().contains(&id) {
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

/// The server, with the stub as its account service, a session of an account, and a session
/// of the relay's alone.
struct World {
    mcp: String,
    session: String,
    plain: String,
}

async fn world() -> World {
    let stub = Arc::new(Stub::default());
    let service = serve(
        axum::Router::new()
            .route("/api/me", get(me))
            .route("/api/openapi.json", get(document))
            .route("/api/sessions", get(sessions))
            .route("/api/sessions/{id}", axum::routing::patch(rename))
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
    let plain = client.create(&relay).await.unwrap();
    World {
        mcp: format!("{mcp}/mcp"),
        session,
        plain,
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
async fn every_request_without_a_token_is_challenged() {
    let world = world().await;
    for session in [&world.session, &world.plain] {
        let answer = post_join(&world.mcp, session, None).await;
        assert_eq!(answer.status(), 401);
        let challenge = answer.headers()["www-authenticate"].to_str().unwrap();
        assert_eq!(
            challenge,
            format!(r#"Bearer resource_metadata="{METADATA}""#)
        );
    }
    // Connecting at all, before any tool.
    let initialize = reqwest::Client::new()
        .post(&world.mcp)
        .header("accept", "application/json, text/event-stream")
        .json(&serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
        .send()
        .await
        .unwrap();
    assert_eq!(initialize.status(), 401);
}

#[tokio::test]
async fn a_token_the_service_rejects_is_challenged() {
    let world = world().await;
    let answer = post_join(&world.mcp, &world.session, Some("t-ben")).await;
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
    let joined = join_as(&client, &world.session, "luis/claude").await;
    assert_ne!(joined.is_error, Some(true), "{joined:?}");
    let said = text(&joined);
    assert!(
        said.contains(r#""name":"luis/claude","you":true,"verified":true"#),
        "{said}"
    );
    // A session of a project tells its repos, as the service says them.
    assert!(
        said.contains(r#"The session, as Vibe Together knows it: {"project":"vibetogether","repos":["https://github.com/PotentialHedge/vibetogether"]}"#),
        "{said}"
    );
    let refused = join_as(&client, &world.session, "ben/claude").await;
    assert_eq!(refused.is_error, Some(true));
    assert!(text(&refused).contains("not your name"), "{refused:?}");
}

#[tokio::test]
async fn a_session_no_account_owns_is_no_vibe_together_session() {
    let world = world().await;
    let client = client(&world.mcp, Some("t-luis")).await;
    let refused = join_as(&client, &world.plain, "luis/claude").await;
    assert_eq!(refused.is_error, Some(true));
    assert!(
        text(&refused).contains("no Vibe Together session"),
        "{refused:?}"
    );
}

#[tokio::test]
async fn the_account_operations_are_tools_that_ask_to_sign_in_first() {
    let world = world().await;
    let call = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "list_sessions", "arguments": {}},
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
    let tools = client.list_all_tools().await.unwrap();
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    assert!(
        names.contains(&"list_sessions") && names.contains(&"rename_session"),
        "{names:?}"
    );
    // What only the person does in the browser is no tool.
    assert!(!names.contains(&"delete_account"), "{names:?}");
    let rename = tools
        .iter()
        .find(|tool| tool.name == "rename_session")
        .unwrap();
    assert_eq!(rename.description.as_deref(), Some("Renames a session."));
    assert_eq!(
        serde_json::Value::Object((*rename.input_schema).clone()),
        serde_json::json!({"type": "object", "properties": {
            "id": {"type": "string"}, "name": {"type": "string", "description": "A name."},
        }, "required": ["id", "name"]}),
    );
    let instructions = client
        .peer_info()
        .unwrap()
        .instructions
        .clone()
        .unwrap_or_default();
    assert!(
        instructions.contains("Sessions: Every session is one of a project's."),
        "{instructions}"
    );

    let listed = client
        .call_tool(CallToolRequestParams::new("list_sessions"))
        .await
        .unwrap();
    assert_eq!(text(&listed), r#"[{"id":"s_1","name":"agents"}]"#);
    // A path argument stays one segment, whatever it holds.
    let renamed = client
        .call_tool(
            CallToolRequestParams::new("rename_session")
                .with_arguments(object!({"id": "s_1/../x", "name": "hedge"})),
        )
        .await
        .unwrap();
    assert_eq!(text(&renamed), r#"{"id":"s_1/../x","name":"hedge"}"#);
}
