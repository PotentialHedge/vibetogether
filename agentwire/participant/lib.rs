//! A participant's side of agentwire, the transport that `agentwire.md` specifies:
//! the types of what goes over the wire, and with the `client` feature, the client.
//! The relay uses the same types, so that each is defined once.
//!
//! The client is stateless: every operation takes the participant's own link,
//! which joining returns, so the caller keeps nothing else.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub mod chat;
#[cfg(feature = "client")]
mod client;
#[cfg(feature = "client")]
pub use client::{Client, Error, Payload, Receive, Refusal};

/// The public relay.
pub const RELAY: &str = "https://agentwire.agentics.lwirth.com";

/// The type of a join entry.
pub const JOIN: &str = "application/vnd.agentwire.join";
/// The type of a leave entry.
pub const LEAVE: &str = "application/vnd.agentwire.leave";
/// The type of a participant's public key.
pub const KEY: &str = "application/vnd.agentwire.key";
/// The type of a secret, encrypted to its recipient's key.
pub const SECRET: &str = "application/vnd.agentwire.secret+json";

/// The largest payload the relay takes, in bytes.
pub const MAX_PAYLOAD: u64 = 10 * 1024 * 1024;

/// An entry of the log, as a receive returns it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Entry {
    pub n: u64,
    /// When it was appended, in UTC, as RFC 3339.
    pub time: String,
    pub from: String,
    /// The payload's MIME type, with its parameters.
    #[serde(rename = "type")]
    pub kind: String,
    /// The payload's length in bytes.
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// The payload itself, where it is short text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The account the access service vouched for the sender by when it was
    /// appended, if any: only then is `from` verified, whoever holds the name later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

impl Entry {
    /// Its type without parameters.
    pub fn essence(&self) -> &str {
        essence(&self.kind)
    }

    /// Whether its type is `kind`, whatever the parameters and the case.
    pub fn is(&self, kind: &str) -> bool {
        self.essence().eq_ignore_ascii_case(kind)
    }

    /// The value of its type's parameter `key`.
    pub fn parameter(&self, key: &str) -> Option<&str> {
        parameter(&self.kind, key)
    }
}

/// One participant's presence: how far it has read, and whether it receives now,
/// or since when it doesn't.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Presence {
    pub read: u64,
    pub receiving: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// The account it joined with, on a relay whose access service vouches for
    /// it: only then is its name verified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// The answer to a join.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Joined {
    /// The number of the join entry.
    pub n: u64,
    pub name: String,
    /// The read position.
    pub read: u64,
    /// The participant's own link, a secret: whoever holds it acts under its name.
    pub link: String,
}

/// The answer to a send or a leave: the number of the entry it appended.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct Appended {
    pub n: u64,
}

/// What a receive returned: the entries, and everyone's presence, by name.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Received {
    pub entries: Vec<Entry>,
    pub presence: BTreeMap<String, Presence>,
}

#[derive(Serialize, Deserialize)]
struct PresenceLine {
    presence: BTreeMap<String, Presence>,
}

impl Received {
    /// Parses a receive's answer: one entry per line, and the presence as the last line.
    pub fn parse(body: &str) -> Result<Self, serde_json::Error> {
        let mut lines: Vec<&str> = body
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let presence = match lines.pop() {
            Some(line) => serde_json::from_str::<PresenceLine>(line)?.presence,
            None => BTreeMap::new(),
        };
        let entries = lines
            .into_iter()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?;
        Ok(Self { entries, presence })
    }

    /// The presence line, as the relay writes it last.
    pub fn presence_line(presence: &BTreeMap<String, Presence>) -> String {
        serde_json::to_string(&PresenceLine {
            presence: presence.clone(),
        })
        .expect("a presence is JSON")
    }
}

/// A MIME type without its parameters.
pub fn essence(kind: &str) -> &str {
    kind.split(';').next().unwrap_or_default().trim()
}

/// The value of a MIME type's parameter `key`, in any case, unquoted.
pub fn parameter<'a>(kind: &'a str, key: &str) -> Option<&'a str> {
    kind.split(';').skip(1).find_map(|parameter| {
        let (name, value) = parameter.split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case(key)
            .then(|| value.trim().trim_matches('"'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receive_parses() {
        let body = concat!(
            r#"{"n":3,"time":"2026-10-21T09:15:02Z","from":"luis","type":"text/plain; charset=utf-8","size":6,"text":"Hello."}"#,
            "\n",
            r#"{"presence":{"luis":{"read":3,"receiving":false,"since":"2026-10-21T09:15:02Z"},"luis/claude":{"read":2,"receiving":true}}}"#,
            "\n",
        );
        let received = Received::parse(body).unwrap();
        assert_eq!(received.entries.len(), 1);
        assert_eq!(received.entries[0].text.as_deref(), Some("Hello."));
        assert!(received.entries[0].is("TEXT/plain"));
        assert!(received.presence["luis/claude"].receiving);
    }

    #[test]
    fn a_parameter_is_found() {
        let kind = r#"text/markdown; charset=utf-8; Ping="luis luis/claude""#;
        assert_eq!(essence(kind), "text/markdown");
        assert_eq!(parameter(kind, "ping"), Some("luis luis/claude"));
        assert_eq!(parameter(kind, "to"), None);
    }
}
