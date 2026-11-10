//! The agentwire relay: the transport that `agentwire.md` specifies, over plain
//! HTTP, with every session in one SQLite database.

mod access;
mod limits;
mod sessions;

use std::borrow::Cow;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{
    AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE,
    HOST, REFERRER_POLICY, RETRY_AFTER, X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use http_body_util::{BodyExt, Full};
use serde::Serialize;
use tokio::time::{sleep, timeout};

use access::{About, Access, Admitted, Credential, Verdict};
use limits::{COST, Limits};
use sessions::Kept;
use sessions::{Answer, MAX_NAME, Reading, Receive, Sessions, Ticket, is_name, is_secret};

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
    /// For a 503, in how many seconds to try again, by default a minute.
    retry: Option<u64>,
}

fn fail(status: u16, why: impl Into<Cow<'static, str>>) -> Fail {
    Fail {
        status: StatusCode::from_u16(status).expect("a status is valid"),
        why: why.into(),
        retry: None,
    }
}

/// A refusal of a request over the relay's limits, which may pass in `retry` seconds.
fn busy(why: impl Into<Cow<'static, str>>, retry: u64) -> Fail {
    Fail {
        retry: Some(retry.max(1)),
        ..fail(503, why)
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
                .insert(RETRY_AFTER, HeaderValue::from(self.retry.unwrap_or(60)));
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
    /// The access service's URL, which decides who may be in an owned session,
    /// and whether it still exists.
    pub access: Option<String>,
    /// The bytes that stay free on the database's filesystem: below them,
    /// the relay refuses whatever adds to it.
    pub min_free: Option<u64>,
}

pub struct Relay {
    sessions: Mutex<Sessions>,
    limits: Mutex<Limits>,
    database: Option<PathBuf>,
    min_free: Option<u64>,
    files: Option<PathBuf>,
    access: Option<Access>,
}

impl Relay {
    pub fn open(options: Options) -> rusqlite::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            sessions: Mutex::new(Sessions::open(options.database.as_deref())?),
            limits: Mutex::default(),
            database: options.database,
            min_free: options.min_free,
            files: options.files,
            access: options.access.as_deref().map(Access::new),
        }))
    }

    /// Lets `client` add a session, a participant or an entry of `bytes`, if
    /// the disk has room for it and the client hasn't added too much lately.
    fn adds(&self, client: Option<IpAddr>, bytes: usize) -> Result<(), Fail> {
        let bytes = bytes as u64;
        if let (Some(min_free), Some(database)) = (self.min_free, &self.database)
            && limits::free(database).is_some_and(|free| free < min_free + bytes)
        {
            return Err(busy("the relay is out of room for now", 300));
        }
        if let Some(client) = client
            && let Err(retry) = self.limits().take(client, COST + bytes)
        {
            return Err(busy(
                format!("this client added too much lately: try again in {retry} seconds"),
                retry,
            ));
        }
        Ok(())
    }

    fn limits(&self) -> MutexGuard<'_, Limits> {
        self.limits.lock().unwrap_or_else(PoisonError::into_inner)
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

    /// Whether a session due to end ends: always, unless it is owned and the
    /// access service keeps it.
    async fn ends(&self, session: &str) -> bool {
        match &self.access {
            Some(access) if self.sessions().owned(session).unwrap_or(false) => {
                access.ends(session).await
            }
            _ => true,
        }
    }

    /// What the access service says to `name` being in `session` with `token`:
    /// nothing where it isn't asked, in a session that isn't owned and without
    /// a token. A owned session fails closed without an answer; any other goes
    /// on without one.
    async fn verdict(
        &self,
        access: &Access,
        session: &str,
        name: &str,
        credential: Credential<'_>,
    ) -> Result<Option<Verdict>, Fail> {
        let owned = self.sessions().owned(session)?;
        if !owned && credential.is_none() {
            return Ok(None);
        }
        match access.ask(session, name, credential, owned).await? {
            Verdict::Silent if owned => Err(fail(503, "the relay can't reach its access service")),
            verdict => Ok(Some(verdict)),
        }
    }

    /// Whether `account`, which the access service vouched for on a join under
    /// `name`, takes the name back from whoever holds it: where the name is the
    /// account's, from a holder of no account or another one, or of the same
    /// one that left, is no longer live, or whose own token is refused now.
    /// A live holder of the same account keeps it, such as another agent on the
    /// same machine.
    async fn takes_back(
        &self,
        access: &Access,
        session: &str,
        name: &str,
        account: &str,
    ) -> Result<bool, Fail> {
        let own = name == account
            || name
                .strip_prefix(account)
                .is_some_and(|rest| rest.starts_with('/'));
        let Some(holder) = self.sessions().holder(session, name)? else {
            return Ok(false);
        };
        if !own {
            return Ok(false);
        }
        if holder.account.as_deref() != Some(account) || !holder.inside || !holder.live {
            return Ok(true);
        }
        let owned = self.sessions().owned(session)?;
        Ok(matches!(
            access.ask(session, name, holder.kept.credential(), owned).await,
            Err(refused) if refused.status == StatusCode::FORBIDDEN
        ))
    }

    /// Lets whoever presents `token`, if anything, read the session without joining it, if
    /// the access service lets them: in an owned session always, and in any other only with
    /// a token, as for a join. Without a service, whoever has the session's address reads it.
    async fn may_read(&self, session: &str, token: Option<&str>) -> Result<(), Fail> {
        self.sessions().enter(session)?;
        let Some(access) = &self.access else {
            return Ok(());
        };
        let owned = self.sessions().owned(session)?;
        if !owned && token.is_none() {
            return Ok(());
        }
        match access.read(session, token, owned).await? {
            Verdict::Silent if owned => Err(fail(503, "the relay can't reach its access service")),
            _ => Ok(()),
        }
    }

    /// Lets the caller act, if the access service lets it be in the session,
    /// with the token it presents now or else what is kept of the one it joined
    /// with; what it is let in with is kept, and so is the account vouched for.
    /// Answers what the service says about the session, if anything.
    async fn admit(
        &self,
        session: &str,
        secret: &str,
        token: Option<&str>,
    ) -> Result<Option<About>, Fail> {
        let Some(access) = &self.access else {
            return Ok(None);
        };
        // A link that is no participant's fails as the operation would.
        let Ok((name, kept, vouched)) = self.sessions().credentials(session, secret) else {
            return Ok(None);
        };
        let credential = token.map_or_else(|| kept.credential(), Credential::Token);
        let verdict = self.verdict(access, session, &name, credential).await;
        // Refused, its name is no longer vouched for.
        if let Err(refused) = &verdict
            && refused.status == StatusCode::FORBIDDEN
            && vouched.is_some()
        {
            self.sessions().vouch(session, secret, &kept, None)?;
        }
        // Without an answer, it goes on as it was.
        let Some(Verdict::Admitted(said)) = verdict? else {
            return Ok(None);
        };
        let now = keeps(&kept, token, &said);
        if now != kept || said.account != vouched {
            self.sessions()
                .vouch(session, secret, &now, said.account.as_deref())?;
        }
        Ok(said.about)
    }

    fn sessions(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A waiting read, which its caller abandons by going away.
struct Read<'a> {
    relay: &'a Relay,
    client: Option<IpAddr>,
    reading: Reading,
}

impl Drop for Read<'_> {
    fn drop(&mut self) {
        self.relay.sessions().abandon_read(&self.reading);
        if let Some(client) = self.client {
            self.relay.limits().waited(client);
        }
    }
}

/// A waiting receive, which its caller abandons by going away.
struct Waiting<'a> {
    relay: &'a Relay,
    client: Option<IpAddr>,
    ticket: Ticket,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        _ = self.relay.sessions().abandon(&self.ticket);
        if let Some(client) = self.client {
            self.relay.limits().waited(client);
        }
    }
}

async fn handle(State(relay): State<Arc<Relay>>, request: Request) -> Response {
    let started = std::time::Instant::now();
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0);
    let client = limits::client(peer, request.headers());
    let (method, target) = (request.method().clone(), logged(request.uri()));
    let receiving = request.method() == Method::GET && in_session(request.uri().path());
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        route(&relay, client, request)
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
    let (status, took) = (response.status().as_u16(), started.elapsed().as_millis());
    eprintln!("{method} {target} {status} {took}ms");
    response
}

/// A request's target as the log keeps it: a session's address and a participant's
/// secret are secrets, so they are left out, and so are the query's values, which
/// hold names; the operation and the query's keys stay.
fn logged(uri: &axum::http::Uri) -> String {
    let mut path: Vec<&str> = uri.path().split('/').collect();
    if let Some(at) = path.iter().position(|part| *part == "s") {
        for part in path.iter_mut().skip(at + 1).take(2) {
            if !part.is_empty() && *part != "join" {
                *part = "…";
            }
        }
    }
    let keys: Vec<String> = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .map(|(key, _)| key.into_owned())
        .collect();
    match keys.is_empty() {
        true => path.join("/"),
        false => format!("{}?{}", path.join("/"), keys.join("&")),
    }
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

/// What the relay keeps of a participant's credential once the access service let it in,
/// having kept `kept` and been presented `token` now: the grant the service gave in place
/// of the token, so that no token stays on the relay's disk, or else the newest token.
fn keeps(kept: &Kept, token: Option<&str>, said: &Admitted) -> Kept {
    match (&said.grant, token) {
        (Some(grant), _) => Kept {
            token: None,
            grant: Some(grant.clone()),
        },
        (None, Some(token)) => Kept {
            token: Some(token.to_owned()),
            grant: None,
        },
        (None, None) => kept.clone(),
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

async fn route(relay: &Relay, client: Option<IpAddr>, request: Request) -> Result<Response, Fail> {
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
            takes(query, "creating a session", &["owned"])?;
            let owned = param(query, "owned").is_some();
            relay.adds(client, 0)?;
            let id = relay.sessions().create(owned)?;
            Ok(text(format!("{origin}/{VERSION}/s/{id}\n"), PLAIN))
        }
        [VERSION, "s", id, rest @ ..] => {
            let link = format!("{origin}/{VERSION}/s/{id}");
            session(
                relay,
                client,
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
    client: Option<IpAddr>,
    id: &str,
    rest: &[&str],
    method: &Method,
    headers: &HeaderMap,
    query: &str,
    body: Body,
    link: &str,
) -> Result<Response, Fail> {
    if !is_secret(id) {
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
    let about = if !["join", "log"].contains(secret) && operation != ["leave"] {
        relay.admit(id, secret, token.as_deref()).await?
    } else {
        None
    };
    match (*secret, operation) {
        ("log", []) if get => {
            takes(
                query,
                "a read",
                &["after", "wait", "only", "skip", "presence"],
            )?;
            read(relay, client, id, token.as_deref(), query).await
        }
        ("join", []) if post => {
            takes(query, "a join", &["as"])?;
            relay.adds(client, 0)?;
            let name = param(query, "as");
            let mut account = None;
            let mut about = None;
            let mut kept = Kept {
                token: token.clone(),
                grant: None,
            };
            if let (Some(access), Some(name)) = (&relay.access, name.as_deref())
                && is_name(name)
                && name.len() <= MAX_NAME
                && let Some(Verdict::Admitted(said)) = relay
                    .verdict(
                        access,
                        id,
                        name,
                        token.as_deref().map_or(Credential::None, Credential::Token),
                    )
                    .await?
            {
                kept = keeps(&Kept::default(), token.as_deref(), &said);
                account = said.account;
                about = said.about;
            }
            let take_back = match (&relay.access, name.as_deref(), account.as_deref()) {
                (Some(access), Some(name), Some(account)) => {
                    relay.takes_back(access, id, name, account).await?
                }
                _ => false,
            };
            let joined = relay.sessions().join(
                id,
                name.as_deref(),
                link,
                &kept,
                account.as_deref(),
                take_back,
            )?;
            Ok(json(&agentwire::Joined { about, ..joined }))
        }
        (_, []) if post => {
            takes(query, "a send", &["filename"])?;
            send(relay, client, id, secret, headers, query, body).await
        }
        (_, []) if get => {
            takes(
                query,
                "a receive",
                &["after", "read", "wait", "only", "skip", "own", "presence"],
            )?;
            receive(relay, client, id, secret, query).await
        }
        (_, ["join"]) if post => {
            takes(query, "joining again", &[])?;
            relay.adds(client, 0)?;
            let joined = relay.sessions().rejoin(id, secret, &me)?;
            Ok(json(&agentwire::Joined { about, ..joined }))
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
    client: Option<IpAddr>,
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
    // A payload counts before it is read, as long as it says it is or else as
    // the longest, so that many sends at once hold no more of it in memory than
    // the client may add; what it falls short by is given back.
    let counted = headers
        .get(CONTENT_LENGTH)
        .and_then(|length| length.to_str().ok()?.parse::<usize>().ok())
        .map_or(MAX_PAYLOAD, |length| length.min(MAX_PAYLOAD));
    // A refused payload is still read to its end, and kept nowhere, since a
    // client may not see an answer before it has sent everything.
    if let Err(refused) = relay.adds(client, counted) {
        _ = read_at_most(body, 0).await;
        return Err(refused);
    }
    let payload = read_at_most(body, MAX_PAYLOAD)
        .await?
        .ok_or_else(|| fail(413, format!("a payload is at most {MAX_PAYLOAD} bytes")))?;
    if let Some(client) = client {
        relay
            .limits()
            .give_back(client, counted.saturating_sub(payload.len()));
    }
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

/// A read of the session's entries without joining it, as the spec's "Read" says.
async fn read(
    relay: &Relay,
    client: Option<IpAddr>,
    id: &str,
    token: Option<&str>,
    query: &str,
) -> Result<Response, Fail> {
    relay.may_read(id, token).await?;
    let (receive, wait) = receive_of(query)?;
    if let Some(client) = client
        && !relay.limits().wait(client)
    {
        return Err(busy("this client has too many receives waiting", 60));
    }
    let started = relay.sessions().read(id, receive);
    let (reading, mut answered) = started.inspect_err(|_| {
        if let Some(client) = client {
            relay.limits().waited(client);
        }
    })?;
    let reading = Read {
        relay,
        client,
        reading,
    };
    let answer = match wait {
        None => answered.await,
        Some(wait) => match timeout(wait, &mut answered).await {
            Ok(answer) => answer,
            Err(_) => {
                relay.sessions().read_now(&reading.reading)?;
                answered.await
            }
        },
    };
    let answer = answer.map_err(|_| fail(503, "the relay can't answer right now"))?;
    // A read may wait long past the access service's yes, so it asks again.
    relay.may_read(id, token).await?;
    match answer {
        Answer::Lines(lines, _, held) => {
            let body = Full::new(Bytes::from(lines)).map_frame(move |frame| {
                let _ = &held;
                frame
            });
            Ok(text(Body::new(body), "application/jsonl; charset=utf-8"))
        }
        Answer::Replaced | Answer::TakenBack => Err(fail(503, "the relay can't answer right now")),
    }
}

/// What a receive or a read asks for, and how long it waits, as its query gives them.
fn receive_of(query: &str) -> Result<(Receive, Option<Duration>), Fail> {
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
    Ok((receive, wait))
}

async fn receive(
    relay: &Relay,
    client: Option<IpAddr>,
    id: &str,
    secret: &str,
    query: &str,
) -> Result<Response, Fail> {
    let (receive, wait) = receive_of(query)?;
    if let Some(client) = client
        && !relay.limits().wait(client)
    {
        return Err(busy("this client has too many receives waiting", 60));
    }
    let started = relay.sessions().receive(id, secret, receive);
    let (ticket, mut answered) = started.inspect_err(|_| {
        if let Some(client) = client {
            relay.limits().waited(client);
        }
    })?;
    let waiting = Waiting {
        relay,
        client,
        ticket,
    };
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
        Answer::Lines(lines, read, held) => {
            relay.sessions().settle(&waiting.ticket, read)?;
            // The answer counts as held until its body is sent, or dropped.
            let body = Full::new(Bytes::from(lines)).map_frame(move |frame| {
                let _ = &held;
                frame
            });
            Ok(text(Body::new(body), "application/jsonl; charset=utf-8"))
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

#[cfg(test)]
mod logged {
    use super::logged;

    #[test]
    fn the_log_keeps_no_secret() {
        let cases = [
            ("/v2/s?owned", "/v2/s?owned"),
            ("/v2/s/AAAA/join?as=luis", "/v2/s/…/join?as"),
            ("/v2/s/AAAA/BBBB?after=3&wait=540", "/v2/s/…/…?after&wait"),
            ("/v2/s/AAAA/BBBB/leave", "/v2/s/…/…/leave"),
            ("/v2/s/AAAA/BBBB/7", "/v2/s/…/…/7"),
            ("/agentwire.md", "/agentwire.md"),
        ];
        for (target, kept) in cases {
            assert_eq!(logged(&target.parse().unwrap()), kept);
        }
    }
}
