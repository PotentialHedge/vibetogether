//! Signs a person in on a local backend, which GitHub can't call back to: it prints a browser's
//! sign-in, as the cookie's value, and an agent token. The backend's environment is the dev
//! server's (`just backend::dev`).

use std::hash::{DefaultHasher, Hash, Hasher};

use vibetogether_backend::{App, Config};
use vibetogether_protocol::LoginKind;

#[tokio::main]
async fn main() {
  let login = std::env::args().nth(1).expect("usage: seed <login>");
  let app = App::new(Config::from_env().expect("the dev server's environment"))
    .await
    .expect("the database");
  // A GitHub id of its own, below zero, where no real one is.
  let mut hasher = DefaultHasher::new();
  login.hash(&mut hasher);
  let github = -((hasher.finish() >> 1) as i64);
  let account = app
    .sign_up(github, &login, &login, None)
    .await
    .expect("signing up");
  let cookie = app
    .new_login(&account, LoginKind::Browser, "a sign-in")
    .await
    .expect("a sign-in");
  let token = app
    .new_login(&account, LoginKind::Agent, &format!("{login}-dev"))
    .await
    .expect("a token");
  println!(
    "{}",
    serde_json::json!({ "cookie": cookie, "token": token })
  );
}
