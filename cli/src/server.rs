//! The one server the command line talks to, `--server`, else the default one, and the token it
//! sends there: VIBETOGETHER_TOKEN, else the token file. Every server stands on its own, and an
//! id is that server's alone.

use std::{fs, path::PathBuf};

use crate::doctor::Source;

pub const DEFAULT_SERVER: &str = "https://vibetogether.potentialhedge.com";

/// Whether `server` is one a token may go to: HTTPS, or plain HTTP to loopback alone, as the HTTP
/// client reads its URL, so that no token goes out in the clear.
pub fn is_secure(server: &str) -> bool {
  let Ok(url) = url::Url::parse(server) else {
    return false;
  };
  let loopback = matches!(
    url.host(),
    Some(url::Host::Domain("localhost"))
      | Some(url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST))
      | Some(url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST))
  );
  match url.scheme() {
    "https" => true,
    "http" => loopback,
    _ => false,
  }
}

/// The token, from VIBETOGETHER_TOKEN, else the token file, with where it came from.
pub fn token() -> (Option<String>, Source) {
  let (stored, source) = match std::env::var("VIBETOGETHER_TOKEN") {
    Ok(token) => (token, Source::Environment),
    Err(_) => match token_file().and_then(|f| Some((fs::read_to_string(&f).ok()?, f))) {
      Some((stored, file)) => (stored, Source::File(file)),
      None => return (None, Source::None),
    },
  };
  // A token is one line.
  match stored.lines().map(str::trim).find(|l| !l.is_empty()) {
    Some(token) => (Some(token.to_string()), source),
    None => (None, Source::None),
  }
}

pub fn token_file() -> Option<PathBuf> {
  let config = std::env::var_os("XDG_CONFIG_HOME")
    .map(PathBuf::from)
    .or_else(|| std::env::home_dir().map(|home| home.join(".config")))?;
  Some(config.join("vibetogether/token"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_token_goes_out_only_encrypted() {
    assert!(is_secure(DEFAULT_SERVER));
    assert!(is_secure("http://127.0.0.1:3000"));
    assert!(is_secure("http://localhost:3000"));
    assert!(!is_secure("http://vibetogether.potentialhedge.com"));
    assert!(!is_secure("http://localhost.evil.com"));
    assert!(!is_secure("vibetogether.potentialhedge.com"));
  }
}
