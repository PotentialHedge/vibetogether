//! The access service, which the relay asks whether a participant may be in a
//! session, and whether a session lasts: `agentwire.md`, "Access".

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{Fail, fail};

/// How long the service may take to answer.
const ANSWER: Duration = Duration::from_secs(10);
/// How long a yes holds before the service is asked again.
const ADMITTED: Duration = Duration::from_secs(5);
/// How long a session the service kept is kept before it is asked again.
const KEPT: Duration = Duration::from_secs(60 * 60);

/// A participant, by session, name and credential.
type Key = (String, String, Option<String>);

/// What a participant is asked about with: the token it presents, or the grant the service
/// gave the relay to keep in its place, or nothing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Credential<'a> {
    None,
    Token(&'a str),
    Grant(&'a str),
}

impl Credential<'_> {
    fn key(self) -> Option<String> {
        match self {
            Credential::None => None,
            Credential::Token(token) => Some(format!("token {token}")),
            Credential::Grant(grant) => Some(format!("grant {grant}")),
        }
    }

    pub fn is_none(self) -> bool {
        self == Credential::None
    }
}

pub struct Access {
    url: String,
    http: reqwest::Client,
    /// When each participant, by session, name and credential, was last let in, and what
    /// the service said.
    admitted: Mutex<HashMap<Key, (Instant, Admitted)>>,
    /// When the service last kept each session.
    kept: Mutex<HashMap<String, Instant>>,
}

#[derive(Serialize)]
struct Join<'a> {
    session: &'a str,
    name: &'a str,
    token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant: Option<&'a str>,
    owned: bool,
}

#[derive(Serialize)]
struct Read<'a> {
    session: &'a str,
    token: Option<&'a str>,
    owned: bool,
}

/// What the service said to a participant.
pub enum Verdict {
    /// It may be in.
    Admitted(Admitted),
    /// The service gave no answer.
    Silent,
}

/// A yes: the account the service vouches for, if any, the grant it gives the relay to
/// keep in place of the token, if any, and what it says about the session, passed on unread
/// in the answer to a join.
#[derive(Deserialize, Default, Clone)]
pub struct Admitted {
    pub account: Option<String>,
    pub grant: Option<String>,
    #[serde(default, deserialize_with = "object")]
    pub about: Option<About>,
}

/// What the service says about a session.
pub type About = serde_json::Map<String, serde_json::Value>;

/// An object, or nothing where the service gave anything else.
fn object<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<About>, D::Error> {
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Object(about) => Some(about),
        _ => None,
    })
}

impl Access {
    /// The service at `url`, such as `http://127.0.0.1:3000/agentwire`.
    pub fn new(url: &str) -> Self {
        Self {
            url: url.trim_end_matches('/').to_owned(),
            http: reqwest::Client::new(),
            admitted: Mutex::default(),
            kept: Mutex::default(),
        }
    }

    /// Asks whether `name` may be in `session` with `credential`: refuses with the
    /// service's line why, or answers what the service said, if anything.
    pub async fn ask(
        &self,
        session: &str,
        name: &str,
        credential: Credential<'_>,
        owned: bool,
    ) -> Result<Verdict, Fail> {
        let key = (session.to_owned(), name.to_owned(), credential.key());
        let (token, grant) = match credential {
            Credential::None => (None, None),
            Credential::Token(token) => (Some(token), None),
            Credential::Grant(grant) => (None, Some(grant)),
        };
        let join = Join {
            session,
            name,
            token,
            grant,
            owned,
        };
        self.asked(key, "join", &join).await
    }

    /// Asks whether whoever presents `token`, if anything, may read `session` without
    /// joining it: refuses with the service's line why, or answers what the service said.
    pub async fn read(
        &self,
        session: &str,
        token: Option<&str>,
        owned: bool,
    ) -> Result<Verdict, Fail> {
        // No name is empty, so a read's yes is kept apart from every join's.
        let key = (
            session.to_owned(),
            String::new(),
            token.map(|t| format!("read {t}")),
        );
        let read = Read {
            session,
            token,
            owned,
        };
        self.asked(key, "read", &read).await
    }

    /// What the service at `path` answers `body`, kept a few seconds under `key`.
    async fn asked(&self, key: Key, path: &str, body: &impl Serialize) -> Result<Verdict, Fail> {
        let now = Instant::now();
        {
            let mut admitted = self.admitted.lock().unwrap_or_else(|e| e.into_inner());
            admitted.retain(|_, (at, _)| now.duration_since(*at) < ADMITTED);
            if let Some((_, said)) = admitted.get(&key) {
                return Ok(Verdict::Admitted(said.clone()));
            }
        }
        let response = self
            .http
            .post(format!("{}/{path}", self.url))
            .timeout(ANSWER)
            .json(body)
            .send()
            .await;
        let Ok(response) = response else {
            return Ok(Verdict::Silent);
        };
        match response.status().as_u16() {
            200 => {
                let Ok(body) = response.bytes().await else {
                    return Ok(Verdict::Silent);
                };
                let mut said = serde_json::from_slice::<Admitted>(&body).unwrap_or_default();
                said.account = said.account.filter(|account| !account.is_empty());
                said.grant = said.grant.filter(|grant| !grant.is_empty());
                let mut admitted = self.admitted.lock().unwrap_or_else(|e| e.into_inner());
                admitted.insert(key, (Instant::now(), said.clone()));
                Ok(Verdict::Admitted(said))
            }
            403 => {
                let why = response.text().await.unwrap_or_default();
                let why = why.lines().next().unwrap_or_default().trim().to_owned();
                Err(fail(
                    403,
                    if why.is_empty() {
                        "access refused".to_owned()
                    } else {
                        why
                    },
                ))
            }
            _ => Ok(Verdict::Silent),
        }
    }

    /// Whether `session` ends, as it would without a service: no when the
    /// service still knows it, or doesn't answer, so that an owned session outlives
    /// the service being down. A session kept is asked about again after a while.
    pub async fn ends(&self, session: &str) -> bool {
        let now = Instant::now();
        {
            let mut kept = self.kept.lock().unwrap_or_else(|e| e.into_inner());
            kept.retain(|_, at| now.duration_since(*at) < KEPT);
            if kept.contains_key(session) {
                return false;
            }
        }
        let response = self
            .http
            .get(format!("{}/sessions/{session}", self.url))
            .timeout(ANSWER)
            .send()
            .await;
        let ends = match response {
            Ok(response) if response.status().as_u16() == 404 => Some(true),
            Ok(response) if response.status().is_success() => Some(false),
            _ => None,
        };
        if ends == Some(true) {
            return true;
        }
        let mut kept = self.kept.lock().unwrap_or_else(|e| e.into_inner());
        kept.insert(session.to_owned(), now);
        false
    }
}
