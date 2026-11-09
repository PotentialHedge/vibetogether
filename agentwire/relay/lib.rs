//! The agentwire relay: the transport that `agentwire.md` specifies, over plain
//! HTTP, with every session in one SQLite database.

mod access;
mod sessions;

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{
    AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HOST,
    REFERRER_POLICY, RETRY_AFTER, X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use http_body_util::BodyExt;
use serde::Serialize;
use tokio::time::{sleep, timeout};

use access::{Access, Verdict};
use sessions::{Answer, MAX_NAME, Receive, Sessions, Ticket, is_name, is_token};

/// The transport's version, the first part of every session's path: a
/// breaking change bumps it, and the relay serves only the current one.
const VERSION: &str = "v2";
const MAX_PAYLOAD: usize = agentwire::MAX_PAYLOAD as usize;
/// How long a failed receive or fetch takes to answer, so that a client that
/// receives again at once, in a loop, still sends few requests.
const FAILED_RECEIVE: Duration = Duration::from_secs(10);
const PLAIN: &str = "text/plain; charset=utf-8";
const MARKDOWN: &str = "text/markdown; charset=utf-8";

// The relay's own page is compiled in: a change to it is served only once each
// relay's pin moves to it and the relay restarts. The spec and the script are
// read from files instead.
const PEOPLE: &str = include_str!("people.html");

const CORS: [(&str, &str); 5] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, POST"),
    (
        "access-control-allow-headers",
        "Authorization, Content-Type",
    ),
    ("access-control-expose-headers", "Content-Disposition"),
    ("access-control-max-age", "86400"),
];

/// A failed request: its status, and one line saying why.
pub struct Fail {
    status: StatusCode,
    why: Cow<'static, str>,
}

fn fail(status: u16, why: impl Into<Cow<'static, str>>) -> Fail {
    Fail {
        status: StatusCode::from_u16(status).expect("a status is valid"),
        why: why.into(),
    }
}

impl From<rusqlite::Error> for Fail {
    fn from(_: rusqlite::Error) -> Self {
        fail(503, "the relay can't answer right now")
    }
}

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            [(CONTENT_TYPE, PLAIN)],
            format!("{}\n", self.why),
        )
            .into_response();
        if self.status == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from_static("60"));
        }
        response
    }
}

/// How a relay is set up. The default keeps its sessions in memory, serves
/// no spec, and asks no access service.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// The database the sessions are kept in.
    pub database: Option<PathBuf>,
    /// The directory the spec, `agentwire.md`, and the script, `agentwire`, are
    /// read from at each request, so that a new wording takes effect without a restart.
    pub files: Option<PathBuf>,
    /// The access service's URL, which decides who may be in a session, and
    /// which sessions last.
    pub access: Option<String>,
}

pub struct Relay {
    sessions: Mutex<Sessions>,
    files: Option<PathBuf>,
    access: Option<Access>,
}

impl Relay {
    pub fn open(options: Options) -> rusqlite::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            sessions: Mutex::new(Sessions::open(options.database.as_deref())?),
            files: options.files,
            access: options.access.as_deref().map(Access::new),
        }))
    }

    /// The file `name` of the directory the relay serves its spec and script from.
    fn file(&self, name: &str, kind: &'static str) -> Result<Response, Fail> {
        let missing = || fail(404, format!("this relay serves no {name}"));
        let path = self.files.as_ref().ok_or_else(missing)?.join(name);
        let content = std::fs::read(path).map_err(|_| missing())?;
        Ok(text(content, kind))
    }

    pub fn router(self: Arc<Self>) -> Router {
        Router::new().fallback(handle).with_state(self)
    }

    /// Ends the sessions nobody joined for a day, nobody received in for a
    /// week, or everyone left, checking every minute; with an access service,
    /// only those it doesn't keep.
    pub async fn expire(self: Arc<Self>) {
        loop {
            sleep(Duration::from_secs(60)).await;
            let Ok(expiring) = self.sessions().expiring() else {
                continue;
            };
            for session in expiring {
                if self.ends(&session).await {
                    _ = self.sessions().end(&session);
                }
            }
        }
    }

    /// Whether a session due to end ends: always, unless it is guarded and the
    /// access service keeps it.
    async fn ends(&self, session: &str) -> bool {
        match &self.access {
            Some(access) if self.sessions().guarded(session).unwrap_or(false) => {
                access.ends(session).await
            }
            _ => true,
        }
    }

    /// What the access service says to `name` being in `session` with `token`:
    /// nothing where it isn't asked, in a session that isn't guarded and without
    /// a token. A guarded session fails closed without an answer; any other goes
    /// on without one.
    async fn verdict(
        &self,
        access: &Access,
        session: &str,
        name: &str,
        token: Option<&str>,
    ) -> Result<Option<Verdict>, Fail> {
        let guarded = self.sessions().guarded(session)?;
        if !guarded && token.is_none() {
            return Ok(None);
        }
        match access.ask(session, name, token, guarded).await? {
            Verdict::Silent if guarded => {
                Err(fail(503, "the relay can't reach its access service"))
            }
            verdict => Ok(Some(verdict)),
        }
    }

    /// Lets the caller act, if the access service lets it be in the session,
    /// with the token it presents now or else the one it joined with; a new
    /// token it is let in with is kept, and so is the account vouched for.
    async fn admit(&self, session: &str, secret: &str, token: Option<&str>) -> Result<(), Fail> {
        let Some(access) = &self.access else {
            return Ok(());
        };
        // A link that is no participant's fails as the operation would.
        let Ok((name, kept, vouched)) = self.sessions().credentials(session, secret) else {
            return Ok(());
        };
        let verdict = self
            .verdict(access, session, &name, token.or(kept.as_deref()))
            .await;
        // Refused, its name is no longer vouched for.
        if let Err(refused) = &verdict
            && refused.status == StatusCode::FORBIDDEN
            && vouched.is_some()
        {
            self.sessions().vouch(session, secret, None, None)?;
        }
        // Without an answer, it goes on as it was.
        let Some(Verdict::Admitted(account)) = verdict? else {
            return Ok(());
        };
        let token = token.filter(|token| Some(*token) != kept.as_deref());
        if token.is_some() || account != vouched {
            self.sessions()
                .vouch(session, secret, token, account.as_deref())?;
        }
        Ok(())
    }

    fn sessions(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A waiting receive, which its caller abandons by going away.
struct Waiting<'a> {
    relay: &'a Relay,
    ticket: Ticket,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        _ = self.relay.sessions().abandon(&self.ticket);
    }
}

async fn handle(State(relay): State<Arc<Relay>>, request: Request) -> Response {
    let receiving = request.method() == Method::GET && in_session(request.uri().path());
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        route(&relay, request)
            .await
            .unwrap_or_else(IntoResponse::into_response)
    };
    if receiving && !response.status().is_success() {
        sleep(FAILED_RECEIVE).await;
    }
    for (name, value) in CORS {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}

/// Whether a path is a session's, of any version.
fn in_session(path: &str) -> bool {
    let path = path.trim_start_matches('/');
    let path = match path.split_once('/') {
        Some((version, rest)) if is_version(version) => rest,
        _ => path,
    };
    path.starts_with("s/")
}

fn is_version(segment: &str) -> bool {
    segment
        .strip_prefix('v')
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The number in a path or a query, which saturates rather than overflows.
fn number(text: &str) -> Option<i64> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().unwrap_or(i64::MAX))
}

/// The origin the caller reached the relay at, which every link it gets
/// starts with.
fn origin(headers: &HeaderMap) -> String {
    let header = |name| {
        headers
            .get(name)
            .and_then(|value: &HeaderValue| value.to_str().ok())
    };
    let scheme = header("x-forwarded-proto").unwrap_or("http");
    let host = header(HOST.as_str()).unwrap_or("localhost");
    format!("{scheme}://{host}")
}

/// Refuses a query with a parameter `operation` doesn't take, so that a
/// mistyped one, such as `skp`, fails rather than being ignored.
fn takes(query: &str, operation: &str, keys: &[&str]) -> Result<(), Fail> {
    match form_urlencoded::parse(query.as_bytes()).find(|(key, _)| !keys.contains(&key.as_ref())) {
        None => Ok(()),
        Some((key, _)) => Err(fail(
            400,
            match keys {
                [] => format!("{operation} takes no parameters, and {key} is none"),
                _ => format!(
                    "{operation} takes only {}, and {key} is none of them",
                    keys.join(", ")
                ),
            },
        )),
    }
}

/// The token in an `Authorization: Bearer <token>` header.
fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.trim().split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_owned())
}

fn param<'a>(query: &'a str, key: &str) -> Option<Cow<'a, str>> {
    form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, value)| value)
}

fn text(body: impl Into<Body>, kind: &'static str) -> Response {
    ([(CONTENT_TYPE, kind)], body.into()).into_response()
}

fn json(value: &impl Serialize) -> Response {
    let body = serde_json::to_string(value).expect("an answer is JSON");
    text(format!("{body}\n"), "application/json")
}

fn numbered(n: i64) -> Response {
    json(&agentwire::Appended { n: n as u64 })
}

fn gone(origin: &str) -> Fail {
    fail(
        410,
        format!(
            "agentwire changed to {VERSION}, and this request is from an older client: \
             the spec is at {origin}/agentwire.md, and the script at {origin}/agentwire"
        ),
    )
}

async fn route(relay: &Relay, request: Request) -> Result<Response, Fail> {
    let (parts, body) = request.into_parts();
    let origin = origin(&parts.headers);
    let query = parts.uri.query().unwrap_or("");
    let segments: Vec<&str> = parts.uri.path().split('/').skip(1).collect();
    let get = parts.method == Method::GET;
    match segments.as_slice() {
        [""] if get => Ok(text(PEOPLE, "text/html; charset=utf-8")),
        ["agentwire"] if get => relay.file("agentwire", PLAIN),
        ["agentwire.md"] if get => relay.file("agentwire.md", MARKDOWN),
        ["s", ..] => Err(gone(&origin)),
        [version, ..] if is_version(version) && *version != VERSION => Err(gone(&origin)),
        [VERSION, "s"] if parts.method == Method::POST => {
            takes(query, "creating a session", &["guarded"])?;
            let guarded = param(query, "guarded").is_some();
            let id = relay.sessions().create(guarded)?;
            Ok(text(format!("{origin}/{VERSION}/s/{id}\n"), PLAIN))
        }
        [VERSION, "s", id, rest @ ..] => {
            let link = format!("{origin}/{VERSION}/s/{id}");
            session(
                relay,
                id,
                rest,
                &parts.method,
                &parts.headers,
                query,
                body,
                &link,
            )
            .await
        }
        [VERSION, "s"] => Err(fail(404, "no such operation")),
        _ => Err(fail(404, "no such page")),
    }
}

#[allow(clippy::too_many_arguments)]
async fn session(
    relay: &Relay,
    id: &str,
    rest: &[&str],
    method: &Method,
    headers: &HeaderMap,
    query: &str,
    body: Body,
    link: &str,
) -> Result<Response, Fail> {
    if !is_token(id) {
        return Err(fail(404, "no such session"));
    }
    let [secret, operation @ ..] = rest else {
        return Err(fail(403, "join first: POST <link>/join?as=<name>"));
    };
    relay.sessions().enter(id)?;
    let me = format!("{link}/{secret}");
    let post = method == Method::POST;
    let get = method == Method::GET;
    let token = bearer(headers);
    // Leaving is always let through, so that nobody is kept in.
    if *secret != "join" && operation != ["leave"] {
        relay.admit(id, secret, token.as_deref()).await?;
    }
    match (*secret, operation) {
        ("join", []) if post => {
            takes(query, "a join", &["as"])?;
            let name = param(query, "as");
            let mut account = None;
            if let (Some(access), Some(name)) = (&relay.access, name.as_deref())
                && is_name(name)
                && name.len() <= MAX_NAME
                && let Some(Verdict::Admitted(vouched)) =
                    relay.verdict(access, id, name, token.as_deref()).await?
            {
                account = vouched;
            }
            let joined = relay.sessions().join(
                id,
                name.as_deref(),
                link,
                token.as_deref(),
                account.as_deref(),
            )?;
            Ok(json(&joined))
        }
        (_, []) if post => {
            takes(query, "a send", &["filename"])?;
            send(relay, id, secret, headers, query, body).await
        }
        (_, []) if get => {
            takes(
                query,
                "a receive",
                &["after", "read", "wait", "only", "skip", "own", "presence"],
            )?;
            receive(relay, id, secret, query).await
        }
        (_, ["join"]) if post => {
            takes(query, "joining again", &[])?;
            let joined = relay.sessions().rejoin(id, secret, &me)?;
            Ok(json(&joined))
        }
        (_, ["leave"]) if post => {
            takes(query, "a leave", &[])?;
            let (n, anyone) = relay.sessions().leave(id, secret)?;
            if !anyone && relay.ends(id).await {
                relay.sessions().end(id)?;
            }
            Ok(numbered(n))
        }
        (_, [n]) if get && number(n).is_some() => {
            takes(query, "a fetch", &[])?;
            let n = number(n).unwrap_or_default();
            payload(relay, id, secret, n)
        }
        _ => Err(fail(404, "no such operation")),
    }
}

async fn send(
    relay: &Relay,
    id: &str,
    secret: &str,
    headers: &HeaderMap,
    query: &str,
    body: Body,
) -> Result<Response, Fail> {
    let filename = param(query, "filename");
    if filename.as_ref().is_some_and(|name| name.len() > MAX_NAME) {
        return Err(fail(
            400,
            format!("a file name is at most {MAX_NAME} bytes"),
        ));
    }
    relay.sessions().inside(id, secret)?;
    let payload = read_at_most(body, MAX_PAYLOAD)
        .await?
        .ok_or_else(|| fail(413, format!("a payload is at most {MAX_PAYLOAD} bytes")))?;
    // curl sends this type unless told otherwise, which says nothing.
    let kind = headers
        .get(CONTENT_TYPE)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .filter(|kind| !kind.starts_with("application/x-www-form-urlencoded"))
        .unwrap_or_else(|| PLAIN.to_owned());
    let n = relay
        .sessions()
        .send(id, secret, &kind, filename.as_deref(), &payload)?;
    Ok(numbered(n))
}

/// The body, or none if it is longer than `limit`. A longer one is still read
/// to its end, since a client may not see an answer before it has sent
/// everything.
async fn read_at_most(mut body: Body, limit: usize) -> Result<Option<Vec<u8>>, Fail> {
    let mut payload = Vec::new();
    let mut size = 0;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| fail(400, "the payload was cut off"))?;
        if let Some(data) = frame.data_ref() {
            size += data.len();
            if size <= limit {
                payload.extend_from_slice(data);
            }
        }
    }
    Ok((size <= limit).then_some(payload))
}

async fn receive(relay: &Relay, id: &str, secret: &str, query: &str) -> Result<Response, Fail> {
    let after = match param(query, "after") {
        None => None,
        Some(after) => Some(number(&after).ok_or_else(|| fail(400, "after is a number"))?),
    };
    let read = match param(query, "read") {
        None => None,
        Some(read) => Some(number(&read).ok_or_else(|| fail(400, "read is a number"))?),
    };
    // A wait too long to represent is no limit.
    let wait = match param(query, "wait") {
        None => None,
        Some(wait) => match wait.parse::<f64>() {
            Ok(seconds) if seconds >= 0.0 => Duration::try_from_secs_f64(seconds).ok(),
            _ => return Err(fail(400, "wait is a number of seconds")),
        },
    };
    let flag = |key| param(query, key).is_some_and(|value| value == "1");
    let types = |name: &str| {
        let starts = form_urlencoded::parse(query.as_bytes())
            .filter(|(key, _)| key == name)
            .map(|(_, kind)| kind.to_ascii_lowercase())
            .collect::<Vec<_>>();
        match starts.iter().any(String::is_empty) {
            true => Err(fail(400, format!("{name} is a type, or the start of one"))),
            false => Ok(starts),
        }
    };
    let receive = Receive {
        after,
        read,
        own: flag("own"),
        presence: flag("presence"),
        only: types("only")?,
        skip: types("skip")?,
    };
    let (ticket, mut answered) = relay.sessions().receive(id, secret, receive)?;
    let waiting = Waiting { relay, ticket };
    let answer = match wait {
        None => answered.await,
        Some(wait) => match timeout(wait, &mut answered).await {
            Ok(answer) => answer,
            Err(_) => {
                relay.sessions().answer_now(&waiting.ticket)?;
                answered.await
            }
        },
    };
    let answer = answer.map_err(|_| fail(503, "the relay can't answer right now"))?;
    // A receive may wait long past the access service's yes, so it asks again
    // before it hands anything over, and a revoked token reads nothing more.
    if let Err(refused) = relay.admit(id, secret, None).await {
        relay.sessions().settle(&waiting.ticket, None)?;
        return Err(refused);
    }
    match answer {
        Answer::Lines(lines, read) => {
            relay.sessions().settle(&waiting.ticket, read)?;
            Ok(text(lines, "application/jsonl; charset=utf-8"))
        }
        Answer::Replaced => Err(fail(409, "a newer receive replaced this one")),
        Answer::TakenBack => Err(fail(403, "this name's account took it back")),
    }
}

fn payload(relay: &Relay, id: &str, secret: &str, n: i64) -> Result<Response, Fail> {
    let payload = relay.sessions().payload(id, secret, n)?;
    let mut response = payload.body.into_response();
    let headers = response.headers_mut();
    // The type is the sender's: a payload opened as a page, such as HTML,
    // runs in a sandbox of its own, never as the relay's site. Its URL holds
    // the caller's own link, which no page it opens learns.
    let kind = HeaderValue::from_str(&payload.kind)
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
    headers.insert(CONTENT_TYPE, kind);
    headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if let Some(filename) = payload.filename {
        let disposition = format!("inline; filename*=UTF-8''{}", uri_component(&filename));
        if let Ok(disposition) = HeaderValue::from_str(&disposition) {
            headers.insert(CONTENT_DISPOSITION, disposition);
        }
    }
    Ok(response)
}

/// Percent-encodes every byte but the unreserved ones, as JavaScript's
/// `encodeURIComponent` does.
fn uri_component(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
