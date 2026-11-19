use std::{env, fs, path::PathBuf};

/// What the backend is run with, from its environment.
#[derive(Clone, Debug)]
pub struct Config {
  /// Where the backend is reached from outside, such as `https://vibetogether.potentialhedge.com`,
  /// without a trailing slash.
  pub url: String,
  /// The SQLite database, made where it doesn't exist.
  pub database: PathBuf,
  /// Who people are on this server.
  pub identity: Identity,
  /// The website's build, served beside the API where given, so that one process is the whole
  /// server; a host that serves it itself, such as the public one's Caddy, leaves it out.
  pub site: Option<PathBuf>,
}

/// Where a server's people come from: every server is the same program, and only this differs.
#[derive(Clone, Debug)]
pub enum Identity {
  /// People sign in with GitHub, through its OAuth app, as on the public server.
  GitHub {
    client_id: String,
    client_secret: String,
  },
  /// The server has one person, its owner, under this name: whoever reaches the server is its
  /// owner, so the network it listens on is the boundary, such as loopback or a tailnet. A
  /// sign-in is made at once, and an OTP approves itself, unless a page on another site asked.
  Owner { name: String },
}

impl Config {
  /// `BACKEND_URL`, `BACKEND_DATABASE` and `BACKEND_SITE`, and the identity: `BACKEND_OWNER`
  /// where the server has an owner, else `GITHUB_CLIENT_ID` and the client secret from systemd's
  /// credential `github` where the service has one, else `GITHUB_CLIENT_SECRET`.
  pub fn from_env() -> Result<Self, String> {
    let required = |name: &str| env::var(name).map_err(|_| format!("{name} is not set"));
    let identity = match env::var("BACKEND_OWNER") {
      Ok(name) => Identity::Owner {
        name: name.to_lowercase(),
      },
      Err(_) => {
        let credential = env::var_os("CREDENTIALS_DIRECTORY")
          .map(|dir| PathBuf::from(dir).join("github"))
          .and_then(|file| fs::read_to_string(file).ok());
        Identity::GitHub {
          client_id: required("GITHUB_CLIENT_ID")?,
          client_secret: match credential {
            Some(secret) => secret.trim().to_string(),
            None => required("GITHUB_CLIENT_SECRET")?,
          },
        }
      }
    };
    Ok(Self {
      url: required("BACKEND_URL")?.trim_end_matches('/').to_string(),
      database: required("BACKEND_DATABASE")?.into(),
      identity,
      site: env::var_os("BACKEND_SITE").map(PathBuf::from),
    })
  }

  /// Whether the backend is reached over HTTPS, where every cookie is `__Host-`.
  pub fn secure(&self) -> bool {
    self.url.starts_with("https://")
  }

  /// The owner's name, where the server has one.
  pub fn owner(&self) -> Option<&str> {
    match &self.identity {
      Identity::Owner { name } => Some(name),
      Identity::GitHub { .. } => None,
    }
  }
}
