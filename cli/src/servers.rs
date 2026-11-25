//! The servers this machine reaches: the command line is the union of its servers. Every server
//! is the same program, and a group lives on exactly one, so an id is qualified by its server's
//! host as `<id>@<host>`, such as `s_k3x9q2mf@vibetogether.example`, as email's addresses are; an
//! id without a host is on the base server, `--server`, else the default one.
//!
//! The tokens are pairs of lines, the token, then the server it was issued by and goes to alone,
//! one pair per server, in VIBETOGETHER_TOKEN, else in the token file. An agent has an identity
//! per server, each named as an id is, in `--agent` or VIBETOGETHER_AGENT and in the file
//! `vibetogether` of its IO (MindIO), one per line.

use std::{
  fs, io,
  path::{Path, PathBuf},
};

use crate::doctor::Source;

pub const DEFAULT_SERVER: &str = "https://vibetogether.potentialhedge.com";

/// A server's origin, as the HTTP client reads its URL: HTTPS, or plain HTTP to loopback alone,
/// so that no token goes out in the clear; `None` for anything else.
pub fn origin(server: &str) -> Option<url::Origin> {
  let url = url::Url::parse(server).ok()?;
  let loopback = matches!(
    url.host(),
    Some(url::Host::Domain("localhost"))
      | Some(url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST))
      | Some(url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST))
  );
  match url.scheme() {
    "https" => Some(url.origin()),
    "http" if loopback => Some(url.origin()),
    _ => None,
  }
}

/// A server's host, with its port where it names one other than its scheme's.
pub fn host_of(server: &str) -> String {
  match origin(server) {
    Some(url::Origin::Tuple(_, host, port)) => {
      match url::Url::parse(server).ok().and_then(|u| u.port()) {
        Some(_) => format!("{host}:{port}"),
        None => host.to_string(),
      }
    }
    _ => String::new(),
  }
}

/// The same server, by its origin as the HTTP client reads it.
pub fn same(a: &str, b: &str) -> bool {
  matches!((origin(a), origin(b)), (Some(a), Some(b)) if a == b)
}

/// An id as it is written: the id on its server, and that server's host where it names one.
pub fn split(address: &str) -> (&str, Option<&str>) {
  match address.rsplit_once('@') {
    Some((id, host)) if !host.is_empty() => (id, Some(host)),
    _ => (address, None),
  }
}

/// The tokens this machine holds, each with its server.
pub struct Tokens {
  pub pairs: Vec<(String, String)>,
  pub source: Source,
}

impl Tokens {
  /// From VIBETOGETHER_TOKEN, else the token file: a lone token is the default server's.
  pub fn read() -> Self {
    let (stored, source) = match std::env::var("VIBETOGETHER_TOKEN") {
      Ok(token) => (token, Source::Environment),
      Err(_) => match token_file().and_then(|f| Some((fs::read_to_string(&f).ok()?, f))) {
        Some((stored, file)) => (stored, Source::File(file)),
        None => (String::new(), Source::None),
      },
    };
    let pairs = pairs(&stored);
    let source = if pairs.is_empty() {
      Source::None
    } else {
      source
    };
    Self { pairs, source }
  }

  /// The token for `server`, which goes to no other.
  pub fn of(&self, server: &str) -> Option<&str> {
    self
      .pairs
      .iter()
      .find(|(_, s)| same(s, server))
      .map(|(token, _)| token.as_str())
  }

  /// The server a host names: the one of a token here, else `https://<host>`.
  pub fn server_at(&self, host: &str) -> String {
    self
      .pairs
      .iter()
      .find(|(_, s)| host_of(s).eq_ignore_ascii_case(host))
      .filter(|_| !host.is_empty())
      .map_or_else(|| format!("https://{host}"), |(_, s)| s.clone())
  }
}

/// Pairs of lines, the token then its server; a token with no server after it is the default
/// one's, as a file of one token was before servers were many.
fn pairs(stored: &str) -> Vec<(String, String)> {
  let lines: Vec<&str> = stored
    .lines()
    .map(str::trim)
    .filter(|l| !l.is_empty())
    .collect();
  let mut pairs = Vec::new();
  let mut i = 0;
  while i < lines.len() {
    let token = lines[i].to_string();
    match lines.get(i + 1).filter(|l| l.contains("://")) {
      Some(server) => {
        pairs.push((token, server.trim_end_matches('/').to_string()));
        i += 2;
      }
      None => {
        pairs.push((token, DEFAULT_SERVER.to_string()));
        i += 1;
      }
    }
  }
  pairs
}

/// The token file's pairs with `token` for `server` in place of the one there was.
pub fn with_token(stored: &str, token: &str, server: &str) -> String {
  let mut out = String::new();
  let mut placed = false;
  for (t, s) in pairs(stored) {
    let (t, s) = if same(&s, server) {
      placed = true;
      (token.to_string(), server.to_string())
    } else {
      (t, s)
    };
    out.push_str(&format!("{t}\n{s}\n"));
  }
  if !placed {
    out.push_str(&format!("{token}\n{server}\n"));
  }
  out
}

pub fn token_file() -> Option<PathBuf> {
  let config = std::env::var_os("XDG_CONFIG_HOME")
    .map(PathBuf::from)
    .or_else(|| std::env::home_dir().map(|home| home.join(".config")))?;
  Some(config.join("vibetogether/token"))
}

/// An agent's identities, each an id on a server: from `--agent` or VIBETOGETHER_AGENT, then its
/// IO's file, in order.
pub struct Identities(Vec<String>);

impl Identities {
  pub fn new(given: Option<&str>, mindio: Option<&Path>) -> Self {
    let mut all: Vec<String> = given
      .into_iter()
      .flat_map(|g| g.split([',', ' ', '\n']))
      .map(str::trim)
      .filter(|a| !a.is_empty())
      .map(str::to_string)
      .collect();
    if let Some(mindio) = mindio {
      all.extend(named(mindio));
    }
    Self(all)
  }

  /// The identity on `server`, where `base` is what an id without a host is on.
  pub fn on(&self, server: &str, base: &str) -> Option<&str> {
    self.0.iter().find_map(|address| match split(address) {
      (id, Some(host)) if !host.is_empty() && host_of(server).eq_ignore_ascii_case(host) => {
        Some(id)
      }
      (id, None) if same(server, base) => Some(id),
      _ => None,
    })
  }

  /// The host of the first identity that names one.
  pub fn first_host(&self) -> Option<&str> {
    self.0.iter().find_map(|address| split(address).1)
  }
}

/// The identities the file `vibetogether` of an agent's IO names, one per line, each an agent's id, with
/// its server's host where it is not on the base server.
pub fn named(mindio: &Path) -> Vec<String> {
  match fs::read_to_string(mindio.join(crate::inbox::AGENT_FILE)) {
    Ok(text) => text
      .lines()
      .map(str::trim)
      .filter(|line| valid(line))
      .map(str::to_string)
      .collect(),
    Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
    Err(_) => Vec::new(),
  }
}

/// Whether `address` is an agent's id, with a host or without.
fn valid(address: &str) -> bool {
  let (id, host) = split(address);
  id.starts_with("a_")
    && id.len() > 2
    && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    && host.is_none_or(|h| {
      h.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
    })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tokens_are_pairs_of_lines() {
    let one = pairs("vt_a\n");
    assert_eq!(one, [("vt_a".into(), DEFAULT_SERVER.into())]);
    let two = pairs("vt_a\nhttps://a.example/\n\nvt_b\nhttp://127.0.0.1:3000\n");
    assert_eq!(two[0], ("vt_a".into(), "https://a.example".into()));
    assert_eq!(two[1], ("vt_b".into(), "http://127.0.0.1:3000".into()));
    let replaced = with_token(
      "vt_a\nhttps://a.example\nvt_b\nhttps://b.example\n",
      "vt_c",
      "https://b.example",
    );
    assert_eq!(
      replaced,
      "vt_a\nhttps://a.example\nvt_c\nhttps://b.example\n"
    );
    assert_eq!(
      with_token("", "vt_c", "https://c.example"),
      "vt_c\nhttps://c.example\n"
    );
  }

  #[test]
  fn an_id_names_its_server_by_its_host() {
    assert_eq!(split("s_1@a.example"), ("s_1", Some("a.example")));
    assert_eq!(split("s_1"), ("s_1", None));
    let ids = Identities::new(Some("a_pub, a_priv@home.ts.net"), None);
    assert_eq!(
      ids.on("https://home.ts.net", DEFAULT_SERVER),
      Some("a_priv")
    );
    assert_eq!(ids.on(DEFAULT_SERVER, DEFAULT_SERVER), Some("a_pub"));
    assert_eq!(ids.on("https://other.example", DEFAULT_SERVER), None);
    assert_eq!(ids.first_host(), Some("home.ts.net"));
    assert!(valid("a_k3x9@lwirth-server.taile6c58a.ts.net"));
    assert!(!valid("a_k3x9@evil/x"));
    // A token's server is compared as the HTTP client reads the URL.
    assert!(!same(
      "https:/evil.com/://vibetogether.potentialhedge.com",
      DEFAULT_SERVER
    ));
    assert!(!same(
      "http://vibetogether.potentialhedge.com",
      DEFAULT_SERVER
    ));
    assert!(same(
      "https://vibetogether.potentialhedge.com/",
      DEFAULT_SERVER
    ));
    assert!(origin("http://localhost.evil.com").is_none());
    assert_eq!(host_of("http://127.0.0.1:3000"), "127.0.0.1:3000");
    assert_eq!(host_of(DEFAULT_SERVER), "vibetogether.potentialhedge.com");
  }
}
