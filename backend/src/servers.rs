//! What a server is: every server is the same program, and where its people come from alone
//! differs (`Identity`). Each server stands on its own: it knows of no other, and its website
//! shows only its own sessions.

use axum::{Json, extract::State};
use vibetogether_protocol::{Identity, ServerInfo};

use crate::App;

/// What this server is: anyone's to ask, so that a client knows how its people sign in.
pub async fn info(State(app): State<App>) -> Json<ServerInfo> {
  Json(ServerInfo {
    identity: match app.config.owner() {
      Some(_) => Identity::Owner,
      None => Identity::Github,
    },
    owner: app.config.owner().map(str::to_string),
  })
}
