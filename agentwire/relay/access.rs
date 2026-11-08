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

/// A participant, by session, name and token.
type Key = (String, String, Option<String>);

pub struct Access {
    url: String,
    http: reqwest::Client,
    /// When each participant, by session, name and token, was last let in.
    admitted: Mutex<HashMap<Key, (Instant, Option<String>)>>,
    /// When the service last kept each session.
    kept: Mutex<HashMap<String, Instant>>,
}

#[derive(Serialize)]
struct Join<'a> {
    session: &'a str,
    name: &'a str,
    token: Option<&'a str>,
    guarded: bool,
}

/// What the service said to a participant.
pub enum Verdict {
    /// It may be in, with the account the service vouches for, if any.
    Admitted(Option<String>),
    /// The service gave no answer.
    Silent,
}

#[derive(Deserialize, Default)]
struct Admitted {
    account: Option<String>,
}

#[derive(Deserialize)]
struct Lasting {
    lasting: bool,
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

    /// Asks whether `name` may be in `session` with `token`: refuses with the
    /// service's line why, or answers what the service said, if anything.
    pub async fn ask(
        &self,
        session: &str,
        name: &str,
        token: Option<&str>,
        guarded: bool,
    ) -> Result<Verdict, Fail> {
        let key = (
            session.to_owned(),
            name.to_owned(),
            token.map(str::to_owned),
        );
        let now = Instant::now();
        {
            let mut admitted = self.admitted.lock().unwrap_or_else(|e| e.into_inner());
            admitted.retain(|_, (at, _)| now.duration_since(*at) < ADMITTED);
            if let Some((_, account)) = admitted.get(&key) {
                return Ok(Verdict::Admitted(account.clone()));
            }
        }
        let response = self
            .http
            .post(format!("{}/join", self.url))
            .timeout(ANSWER)
            .json(&Join {
                session,
                name,
                token,
                guarded,
            })
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
                let account = serde_json::from_slice::<Admitted>(&body)
                    .unwrap_or_default()
                    .account
                    .filter(|account| !account.is_empty());
                let mut admitted = self.admitted.lock().unwrap_or_else(|e| e.into_inner());
                admitted.insert(key, (Instant::now(), account.clone()));
                Ok(Verdict::Admitted(account))
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
    /// service keeps it, or doesn't answer, so that a lasting session outlives
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
            Ok(response) if response.status().is_success() => {
                response.json::<Lasting>().await.ok().map(|l| !l.lasting)
            }
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
