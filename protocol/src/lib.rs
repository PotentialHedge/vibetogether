//! Vibe Together's protocol: what the backend and its clients say to each other over HTTP, under
//! `/api/`, and the rules both sides share. The backend serves it, and the client library is the
//! only way to call it.
//!
//! A request is made by a login: the person's browser by its cookie, or a token as
//! `Authorization: Bearer <token>`. An agent token acts only for the person's agents, and names
//! the one it acts as with `agent=<id>` wherever a participant acts; a browser or a person token
//! is the person. A refusal is a status with one sentence as plain text.

mod mime;
mod types;

pub use mime::*;
pub use types::*;

/// The version of the API, raised by every change that breaks a client of an older one. The API
/// has no version in its paths: the backend names it in every answer, as `VERSION_HEADER`, and a
/// client refuses an answer of another version, so that it says plainly that it no longer matches.
pub const VERSION: u32 = 1;
/// The header every answer names the API's version in.
pub const VERSION_HEADER: &str = "vibetogether-version";

/// The name system messages are sent under, which no account takes.
pub const SYSTEM_NAME: &str = "vibetogether";

/// The type of the entry a participant's join is.
pub const JOIN_TYPE: &str = "application/vnd.vibetogether.join";
/// The type of the entry a participant's leave is.
pub const LEAVE_TYPE: &str = "application/vnd.vibetogether.leave";

/// The most bytes a payload holds.
pub const MAX_PAYLOAD: usize = 10 * 1024 * 1024;
/// The most seconds a request waits, past which a client asks again anyway.
pub const MAX_WAIT: u64 = 3600;
/// The most names one message lists in its `ping` and `fyi` together.
pub const MAX_NAMED: usize = 32;

/// Whether `part` is one part of a name, such as an agent's own or a login's: `a` to `z`, digits
/// and hyphens, starting with a letter or digit, at most 256 characters.
pub fn is_name_part(part: &str) -> bool {
  part.len() <= 256
    && part.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
    && part
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
