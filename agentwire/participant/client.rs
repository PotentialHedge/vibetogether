//! The client: each operation of `agentwire.md`, as one request to the relay.

use std::{fmt, time::Duration};

use reqwest::{RequestBuilder, Response, StatusCode};

use crate::{Appended, Joined, MAX_PAYLOAD, Received};

/// How long a request that doesn't wait may take before it counts as lost,
/// so that a connection that hangs without closing holds up nothing for good.
const REQUEST: Duration = Duration::from_secs(60);
/// How much longer than its wait a receive may take before it counts as lost.
const SLACK: Duration = Duration::from_secs(30);

/// What a receive asks for: everything after the read position, waiting until there
/// is something, unless the fields say otherwise.
#[derive(Debug, Clone, Default)]
pub struct Receive {
    /// The entries after this number, instead of after the read position.
    pub after: Option<u64>,
    /// The read position to set, instead of acknowledging what it returns.
    pub read: Option<u64>,
    /// How long it waits at most, and then returns the presence alone.
    pub wait: Option<Duration>,
    /// The caller's own entries too.
    pub own: bool,
    /// Also return when someone's presence changes.
    pub presence: bool,
    /// The starts of the types it wants; with none, every type.
    pub only: Vec<String>,
    /// The starts of the types it skips.
    pub skip: Vec<String>,
}

/// An entry's payload, as fetched.
#[derive(Debug, Clone)]
pub struct Payload {
    pub kind: String,
    pub filename: Option<String>,
    pub bytes: Vec<u8>,
}

/// The relay refused a request, with its one line of why.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub status: u16,
    pub reason: String,
    /// `Retry-After`, in seconds, where the relay gives one.
    pub retry: Option<u64>,
}

#[derive(Debug)]
pub enum Error {
    /// The relay answered, and refused.
    Refused(Refusal),
    /// The relay could not be reached, or the answer was cut off.
    Unreachable(reqwest::Error),
    /// The relay answered something this client doesn't understand.
    Unexpected(String),
}

impl Error {
    /// The status of a refusal.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Refused(refusal) => Some(refusal.status),
            _ => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Refused(Refusal { status, reason, .. }) => {
                write!(f, "the relay refused ({status}): {reason}")
            }
            Self::Unreachable(error) => write!(f, "the relay is unreachable: {error}"),
            Self::Unexpected(why) => write!(f, "an unexpected answer from the relay: {why}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unreachable(error) => Some(error),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::Unreachable(error)
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Unexpected(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// A client of any relay. Cloning it shares its connections.
/// Every request but a receive without `wait` gives up after a while.
#[derive(Debug, Clone, Default)]
pub struct Client {
    http: reqwest::Client,
    /// The address of the client a program acts for, as its proxy named it.
    on_behalf_of: Option<String>,
}

impl Client {
    pub fn new() -> Self {
        Self::default()
    }

    fn post(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        let request = self.http.post(url).timeout(REQUEST);
        match &self.on_behalf_of {
            Some(address) => request.header("x-forwarded-for", address),
            None => request,
        }
    }

    /// This client, acting for a client of the caller's own at `address`, such
    /// as a server's caller: what it adds, a session, a join or an entry, is
    /// named as that client's in `X-Forwarded-For`, which a relay on the same
    /// machine counts against that client's limits.
    pub fn on_behalf_of(&self, address: &str) -> Self {
        Self {
            on_behalf_of: Some(address.to_owned()),
            ..self.clone()
        }
    }

    /// A client on an HTTP client of the caller's.
    pub fn with(http: reqwest::Client) -> Self {
        Self {
            http,
            on_behalf_of: None,
        }
    }

    /// Creates a session on the relay at `relay`, and returns its link.
    pub async fn create(&self, relay: &str) -> Result<String> {
        let url = format!("{}/v2/s", relay.trim_end_matches('/'));
        Ok(text(self.post(url)).await?.trim().to_owned())
    }

    /// Creates a owned session, which the relay's access service decides on alone.
    pub async fn create_owned(&self, relay: &str) -> Result<String> {
        let url = format!("{}/v2/s?owned", relay.trim_end_matches('/'));
        Ok(text(self.post(url)).await?.trim().to_owned())
    }

    /// Joins the session at `link` as `name`, with a token where the relay's
    /// access service asks for one.
    pub async fn join(&self, link: &str, name: &str, token: Option<&str>) -> Result<Joined> {
        let link = link.trim_end_matches('/');
        let request = bearer(
            self.post(format!("{link}/join")).query(&[("as", name)]),
            token,
        );
        Ok(serde_json::from_str(&text(request).await?)?)
    }

    /// Joins again with the participant's own link, after leaving;
    /// while in, it does nothing, and so tells whose the link is.
    /// A token given replaces the one it joined with.
    pub async fn rejoin(&self, me: &str, token: Option<&str>) -> Result<Joined> {
        let request = bearer(self.post(format!("{me}/join")), token);
        Ok(serde_json::from_str(&text(request).await?)?)
    }

    /// Sends a payload of type `kind`, named as a file where it has a name,
    /// and returns its entry's number.
    pub async fn send(
        &self,
        me: &str,
        kind: &str,
        filename: Option<&str>,
        body: impl Into<reqwest::Body>,
    ) -> Result<u64> {
        let mut request = self.post(me).header("content-type", kind).body(body);
        if let Some(filename) = filename {
            request = request.query(&[("filename", filename)]);
        }
        Ok(serde_json::from_str::<Appended>(&text(request).await?)?.n)
    }

    /// Receives, as `receive` asks.
    pub async fn receive(&self, me: &str, receive: &Receive) -> Result<Received> {
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(after) = receive.after {
            query.push(("after", after.to_string()));
        }
        if let Some(read) = receive.read {
            query.push(("read", read.to_string()));
        }
        if let Some(wait) = receive.wait {
            query.push(("wait", wait.as_secs_f64().to_string()));
        }
        if receive.own {
            query.push(("own", "1".into()));
        }
        if receive.presence {
            query.push(("presence", "1".into()));
        }
        query.extend(receive.only.iter().map(|only| ("only", only.clone())));
        query.extend(receive.skip.iter().map(|skip| ("skip", skip.clone())));
        let mut request = self.http.get(me).query(&query);
        if let Some(wait) = receive.wait {
            request = request.timeout(wait + SLACK);
        }
        Ok(Received::parse(&text(request).await?)?)
    }

    /// The payload of entry `n`, with its type and, where it has one, its file name.
    pub async fn fetch(&self, me: &str, n: u64) -> Result<Payload> {
        let request = self.http.get(format!("{me}/{n}")).timeout(REQUEST);
        let mut response = checked(request.send().await?).await?;
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        let kind = header("content-type").unwrap_or_else(|| "application/octet-stream".into());
        let filename = header("content-disposition").and_then(|value| filename(&value));
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() as u64 > MAX_PAYLOAD {
                return Err(Error::Unexpected(format!(
                    "a payload larger than {MAX_PAYLOAD} bytes"
                )));
            }
        }
        Ok(Payload {
            kind,
            filename,
            bytes,
        })
    }

    /// Leaves, and returns the leave entry's number.
    pub async fn leave(&self, me: &str) -> Result<u64> {
        let request = self.post(format!("{me}/leave"));
        Ok(serde_json::from_str::<Appended>(&text(request).await?)?.n)
    }
}

fn bearer(request: RequestBuilder, token: Option<&str>) -> RequestBuilder {
    match token {
        Some(token) => request.bearer_auth(token),
        None => request,
    }
}

/// The response, if the relay accepted the request, or its refusal.
async fn checked(response: Response) -> Result<Response> {
    let status = response.status();
    if status == StatusCode::OK {
        return Ok(response);
    }
    let retry = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok()?.trim().parse().ok());
    let reason = response.text().await?.trim().to_owned();
    Err(Error::Refused(Refusal {
        status: status.as_u16(),
        reason,
        retry,
    }))
}

/// Sends the request, and returns the body of the relay's answer.
async fn text(request: RequestBuilder) -> Result<String> {
    Ok(checked(request.send().await?).await?.text().await?)
}

/// The file name in a `Content-Disposition`, as the relay gives it: `filename*=UTF-8''<encoded>`.
fn filename(disposition: &str) -> Option<String> {
    let (_, encoded) = disposition.split_once("filename*=UTF-8''")?;
    let encoded = encoded.split(';').next()?.trim().as_bytes();
    let mut bytes = Vec::new();
    let mut i = 0;
    while i < encoded.len() {
        if encoded[i] == b'%'
            && let Some(byte) = encoded
                .get(i + 1..i + 3)
                .and_then(|hex| u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok())
        {
            bytes.push(byte);
            i += 3;
        } else {
            bytes.push(encoded[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_file_name_is_decoded() {
        assert_eq!(
            super::filename("inline; filename*=UTF-8''page%20one.png").as_deref(),
            Some("page one.png")
        );
        assert_eq!(super::filename("inline"), None);
    }
}
