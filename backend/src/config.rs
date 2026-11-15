use std::{env, fs, path::PathBuf};

/// What the backend is run with, from its environment.
#[derive(Clone, Debug)]
pub struct Config {
  /// Where the backend is reached from outside, such as `https://vibetogether.potentialhedge.com`,
  /// without a trailing slash.
  pub url: String,
  /// The SQLite database, made where it doesn't exist.
  pub database: PathBuf,
  /// The GitHub OAuth app people sign in through.
  pub github_client_id: String,
  pub github_client_secret: String,
}

impl Config {
  /// `BACKEND_URL`, `BACKEND_DATABASE`, `GITHUB_CLIENT_ID`, and the client secret from systemd's
  /// credential `github` where the service has one, else `GITHUB_CLIENT_SECRET`.
  pub fn from_env() -> Result<Self, String> {
    let required = |name: &str| env::var(name).map_err(|_| format!("{name} is not set"));
    let credential = env::var_os("CREDENTIALS_DIRECTORY")
      .map(|dir| PathBuf::from(dir).join("github"))
      .and_then(|file| fs::read_to_string(file).ok());
    Ok(Self {
      url: required("BACKEND_URL")?.trim_end_matches('/').to_string(),
      database: required("BACKEND_DATABASE")?.into(),
      github_client_id: required("GITHUB_CLIENT_ID")?,
      github_client_secret: match credential {
        Some(secret) => secret.trim().to_string(),
        None => required("GITHUB_CLIENT_SECRET")?,
      },
    })
  }

  /// Whether the backend is reached over HTTPS, where every cookie is `__Host-`.
  pub fn secure(&self) -> bool {
    self.url.starts_with("https://")
  }
}
