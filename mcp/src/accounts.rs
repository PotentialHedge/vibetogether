//! Signing in with an account service such as Vibe Together's.
//!
//! Nothing works without an account, Luis's decision (2026-11-10): every request without a
//! token gets MCP's challenge, a 401 that points at the server's metadata (RFC 9728), from
//! which an MCP client gets a token through the service's OAuth and retries.
//! A token is passed on to the relay on joining, so that the presence shows its account;
//! one the service rejects is challenged too, so that the client signs in again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

/// How long the service's yes to a token is kept: the relay asks again on each of the
/// participant's requests anyway, so a revoked token is cut off there.
const KEEP: Duration = Duration::from_secs(5);
/// How long the service may take to answer.
const ANSWER: Duration = Duration::from_secs(10);

/// The account service, and how the server names itself in its challenge.
pub struct Accounts {
    /// The service's own URL, under which `/api/me` and `/agentwire/sessions/<id>` answer.
    pub(crate) service: String,
    /// What the challenge's `WWW-Authenticate` names: the server's metadata.
    metadata: String,
    /// The relay a session token alone refers to, where the sessions are.
    relay: String,
    pub(crate) http: reqwest::Client,
    /// The service's operations, as last read.
    pub(crate) cache: crate::operations::Cache,
    /// The tokens the service vouched for, until when.
    vouched: Mutex<HashMap<String, Instant>>,
}

impl Accounts {
    /// The service at `service`, such as `http://127.0.0.1:8793`, for the server at its
    /// public URL `resource`, such as `https://vibetogether.potentialhedge.com/mcp`,
    /// whose metadata the service serves where RFC 9728 puts it.
    pub fn new(service: &str, resource: &str) -> Result<Self, String> {
        let resource = reqwest::Url::parse(resource)
            .map_err(|error| format!("the resource {resource:?} is no URL: {error}"))?;
        let metadata = format!(
            "{}/.well-known/oauth-protected-resource{}",
            resource.origin().ascii_serialization(),
            resource.path().trim_end_matches('/'),
        );
        Ok(Self {
            service: service.trim_end_matches('/').to_owned(),
            metadata,
            relay: String::new(),
            http: reqwest::Client::new(),
            cache: Default::default(),
            vouched: Mutex::default(),
        })
    }

    /// The same, with the relay whose sessions may be sessions.
    pub(crate) fn on(mut self, relay: &str) -> Self {
        self.relay = relay.trim_end_matches('/').to_owned();
        self
    }

    /// Whether the service vouches for `token`, or `None` where it gave no answer.
    async fn vouches(&self, token: &str) -> Option<bool> {
        let now = Instant::now();
        {
            let mut vouched = self.vouched.lock().unwrap();
            vouched.retain(|_, until| *until > now);
            if vouched.contains_key(token) {
                return Some(true);
            }
        }
        let answer = self
            .http
            .get(format!("{}/api/me", self.service))
            .bearer_auth(token)
            .timeout(ANSWER)
            .send()
            .await
            .ok()?;
        match answer.status() {
            StatusCode::OK => {
                let mut vouched = self.vouched.lock().unwrap();
                vouched.insert(token.to_owned(), now + KEEP);
                Some(true)
            }
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Some(false),
            _ => None,
        }
    }

    /// Whether `session`, a session's address on the relay, is one of the service's: one an
    /// account owns or a DM, or `None` where the service doesn't answer.
    pub(crate) async fn knows(&self, session: &str) -> Option<bool> {
        let id = session.rsplit('/').next().unwrap_or_default();
        let answer = self
            .http
            .get(format!("{}/agentwire/sessions/{id}", self.service))
            .timeout(ANSWER)
            .send()
            .await
            .ok()?;
        match answer.status() {
            StatusCode::NOT_FOUND => Some(false),
            status if status.is_success() => Some(true),
            _ => None,
        }
    }

    fn challenge(&self, invalid: bool) -> Response {
        let (error, why) = if invalid {
            (
                r#", error="invalid_token""#,
                "sign in again: the account service doesn't know this token\n",
            )
        } else {
            ("", "sign in: this takes a Vibe Together account\n")
        };
        let value = format!(r#"Bearer resource_metadata="{}"{error}"#, self.metadata);
        (StatusCode::UNAUTHORIZED, [(WWW_AUTHENTICATE, value)], why).into_response()
    }
}

/// Challenges a request without a token, or with one the service rejects.
pub async fn check(
    State(accounts): State<Arc<Accounts>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(token) = bearer(request.headers()) else {
        return accounts.challenge(false);
    };
    // Where the service doesn't answer, the relay decides.
    if accounts.vouches(token).await == Some(false) {
        return accounts.challenge(true);
    }
    next.run(request).await
}

/// The request's bearer token, if any.
pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}
