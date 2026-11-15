//! The client for the website, as a WebAssembly module: `Client` in JavaScript, with every
//! operation the website calls as a method that returns a promise. The browser carries the
//! person's sign-in in its cookie, so the client has no token. A long wait takes an
//! `AbortSignal`, which ends it.
//!
//! A refusal rejects with an `Error` whose `status` is the HTTP status; a network failure with
//! one without.

use futures_util::future::{Either, select};
use serde::Serialize;
use tsify::Ts;
use vibetogether_protocol::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::AbortSignal;

use crate::Error;

#[wasm_bindgen(js_name = Client)]
pub struct WebClient(crate::Client);

fn js_error(error: Error) -> JsValue {
  let js = js_sys::Error::new(&error.to_string());
  if let Some(status) = error.status() {
    let _ = js_sys::Reflect::set(&js, &"status".into(), &status.into());
  }
  js.into()
}

fn aborted() -> JsValue {
  let js = js_sys::Error::new("The request was aborted.");
  js.set_name("AbortError");
  js.into()
}

fn to_js(value: &impl Serialize) -> Result<JsValue, JsValue> {
  value
    .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
    .map_err(|e| js_error(Error::Network(e.to_string())))
}

fn from_js<T>(value: Ts<T>) -> Result<T, JsValue>
where
  T: serde::de::DeserializeOwned + tsify::Tsify,
  T::JsType: Clone,
{
  value
    .to_rust()
    .map_err(|e| js_error(Error::Usage(e.to_string())))
}

/// Runs `call` until `signal`, where given, aborts it: the request is dropped, which aborts its
/// fetch.
async fn abortable<T: Serialize>(
  call: impl Future<Output = crate::Result<T>>,
  signal: Option<AbortSignal>,
) -> Result<JsValue, JsValue> {
  let call = std::pin::pin!(call);
  let result = match signal {
    None => call.await,
    Some(signal) => {
      if signal.aborted() {
        return Err(aborted());
      }
      let abort = js_sys::Promise::new(&mut |resolve, _| {
        let _ = signal.add_event_listener_with_callback("abort", &resolve);
      });
      match select(call, JsFuture::from(abort)).await {
        Either::Left((result, _)) => result,
        Either::Right(_) => return Err(aborted()),
      }
    }
  };
  to_js(&result.map_err(js_error)?)
}

async fn done<T: Serialize>(
  call: impl Future<Output = crate::Result<T>>,
) -> Result<JsValue, JsValue> {
  abortable(call, None).await
}

#[wasm_bindgen(js_class = Client)]
impl WebClient {
  /// The client of the backend at `server`, such as the website's own origin.
  #[wasm_bindgen(constructor)]
  pub fn new(server: String) -> WebClient {
    WebClient(crate::Client::new(&server, None))
  }

  #[wasm_bindgen(unchecked_return_type = "Account")]
  pub async fn me(&self) -> Result<JsValue, JsValue> {
    done(self.0.me()).await
  }

  /// Everything the account sees at once; with `version`, once it differs from it.
  #[wasm_bindgen(unchecked_return_type = "Overview")]
  pub async fn overview(
    &self,
    query: Ts<OverviewQuery>,
    signal: Option<AbortSignal>,
  ) -> Result<JsValue, JsValue> {
    let query = from_js(query)?;
    abortable(self.0.overview(&query), signal).await
  }

  #[wasm_bindgen(unchecked_return_type = "Activity[]")]
  pub async fn activity(&self) -> Result<JsValue, JsValue> {
    done(self.0.activity()).await
  }

  #[wasm_bindgen(js_name = deleteAccount)]
  pub async fn delete_account(&self) -> Result<(), JsValue> {
    self.0.delete_account().await.map_err(js_error)
  }

  #[wasm_bindgen(unchecked_return_type = "Group[]")]
  pub async fn groups(&self) -> Result<JsValue, JsValue> {
    done(self.0.groups()).await
  }

  #[wasm_bindgen(js_name = createGroup, unchecked_return_type = "Group")]
  pub async fn create_group(&self, name: String) -> Result<JsValue, JsValue> {
    done(self.0.create_group(&name)).await
  }

  #[wasm_bindgen(js_name = renameGroup, unchecked_return_type = "Group")]
  pub async fn rename_group(&self, id: String, name: String) -> Result<JsValue, JsValue> {
    done(self.0.rename_group(&id, &name)).await
  }

  #[wasm_bindgen(js_name = deleteGroup)]
  pub async fn delete_group(&self, id: String) -> Result<(), JsValue> {
    self.0.delete_group(&id).await.map_err(js_error)
  }

  #[wasm_bindgen(js_name = addMember, unchecked_return_type = "Group")]
  pub async fn add_member(&self, group: String, name: String) -> Result<JsValue, JsValue> {
    done(self.0.add_member(&group, &name)).await
  }

  #[wasm_bindgen(js_name = removeMember)]
  pub async fn remove_member(&self, group: String, name: String) -> Result<(), JsValue> {
    self.0.remove_member(&group, &name).await.map_err(js_error)
  }

  #[wasm_bindgen(unchecked_return_type = "Project[]")]
  pub async fn projects(&self) -> Result<JsValue, JsValue> {
    done(self.0.projects()).await
  }

  #[wasm_bindgen(js_name = createProject, unchecked_return_type = "Project")]
  pub async fn create_project(&self, project: Ts<CreateProject>) -> Result<JsValue, JsValue> {
    let project = from_js(project)?;
    done(self.0.create_project(&project)).await
  }

  #[wasm_bindgen(js_name = changeProject, unchecked_return_type = "Project")]
  pub async fn change_project(
    &self,
    id: String,
    change: Ts<ChangeProject>,
  ) -> Result<JsValue, JsValue> {
    let change = from_js(change)?;
    done(self.0.change_project(&id, &change)).await
  }

  #[wasm_bindgen(js_name = deleteProject)]
  pub async fn delete_project(&self, id: String) -> Result<(), JsValue> {
    self.0.delete_project(&id).await.map_err(js_error)
  }

  #[wasm_bindgen(unchecked_return_type = "Agent[]")]
  pub async fn agents(&self) -> Result<JsValue, JsValue> {
    done(self.0.agents()).await
  }

  #[wasm_bindgen(js_name = createAgent, unchecked_return_type = "Agent")]
  pub async fn create_agent(&self, name: String) -> Result<JsValue, JsValue> {
    done(self.0.create_agent(&name)).await
  }

  #[wasm_bindgen(js_name = renameAgent, unchecked_return_type = "Agent")]
  pub async fn rename_agent(&self, id: String, name: String) -> Result<JsValue, JsValue> {
    done(self.0.rename_agent(&id, &name)).await
  }

  #[wasm_bindgen(js_name = archiveAgent)]
  pub async fn archive_agent(&self, id: String) -> Result<(), JsValue> {
    self.0.archive_agent(&id).await.map_err(js_error)
  }

  #[wasm_bindgen(js_name = setStatus)]
  pub async fn set_status(&self, text: String) -> Result<(), JsValue> {
    self.0.set_status(&text).await.map_err(js_error)
  }

  #[wasm_bindgen(unchecked_return_type = "Session[]")]
  pub async fn sessions(&self) -> Result<JsValue, JsValue> {
    done(self.0.sessions()).await
  }

  #[wasm_bindgen(js_name = createSession, unchecked_return_type = "Session")]
  pub async fn create_session(&self, session: Ts<CreateSession>) -> Result<JsValue, JsValue> {
    let session = from_js(session)?;
    done(self.0.create_session(&session)).await
  }

  #[wasm_bindgen(unchecked_return_type = "Session")]
  pub async fn session(&self, id: String) -> Result<JsValue, JsValue> {
    done(self.0.session(&id)).await
  }

  #[wasm_bindgen(js_name = renameSession, unchecked_return_type = "Session")]
  pub async fn rename_session(&self, id: String, name: String) -> Result<JsValue, JsValue> {
    done(self.0.rename_session(&id, &name)).await
  }

  #[wasm_bindgen(js_name = deleteSession)]
  pub async fn delete_session(&self, id: String) -> Result<(), JsValue> {
    self.0.delete_session(&id).await.map_err(js_error)
  }

  #[wasm_bindgen(unchecked_return_type = "Record<string, Participant>")]
  pub async fn participants(&self, id: String) -> Result<JsValue, JsValue> {
    done(self.0.participants(&id)).await
  }

  #[wasm_bindgen(unchecked_return_type = "Joined")]
  pub async fn join(&self, id: String) -> Result<JsValue, JsValue> {
    done(self.0.join(&id)).await
  }

  #[wasm_bindgen(unchecked_return_type = "Left")]
  pub async fn leave(&self, id: String) -> Result<JsValue, JsValue> {
    done(self.0.leave(&id)).await
  }

  /// Sends `payload` of type `ty`, such as a message of `text/markdown; ping="ben"`.
  #[wasm_bindgen(unchecked_return_type = "Sent")]
  pub async fn send(
    &self,
    id: String,
    ty: String,
    payload: Vec<u8>,
    filename: Option<String>,
  ) -> Result<JsValue, JsValue> {
    done(self.0.send_entry(&id, &ty, payload, filename.as_deref())).await
  }

  /// The payload of entry `n`, as a `Blob` of its type.
  #[wasm_bindgen(unchecked_return_type = "Blob")]
  pub async fn fetch(&self, id: String, n: u32) -> Result<JsValue, JsValue> {
    let payload = self.0.fetch(&id, n.into()).await.map_err(js_error)?;
    let parts = js_sys::Array::of1(&js_sys::Uint8Array::from(payload.bytes.as_slice()));
    let options = web_sys::BlobPropertyBag::new();
    options.set_type(&payload.ty);
    web_sys::Blob::new_with_u8_array_sequence_and_options(&parts, &options).map(Into::into)
  }

  /// Observes the session, which has no side effects; with a `version`, it waits for a change.
  #[wasm_bindgen(unchecked_return_type = "Log")]
  pub async fn log(
    &self,
    id: String,
    query: Ts<LogQuery>,
    signal: Option<AbortSignal>,
  ) -> Result<JsValue, JsValue> {
    let query = from_js(query)?;
    abortable(self.0.log(&id, &query), signal).await
  }

  /// Receives the person's stream, holding them awake or asleep as `state` says.
  #[wasm_bindgen(unchecked_return_type = "Received")]
  pub async fn receive(
    &self,
    query: Ts<ReceiveQuery>,
    signal: Option<AbortSignal>,
  ) -> Result<JsValue, JsValue> {
    let query = from_js(query)?;
    abortable(self.0.receive(&query), signal).await
  }

  #[wasm_bindgen(unchecked_return_type = "Friend[]")]
  pub async fn friends(&self) -> Result<JsValue, JsValue> {
    done(self.0.friends()).await
  }

  #[wasm_bindgen(js_name = addFriend)]
  pub async fn add_friend(&self, name: String) -> Result<(), JsValue> {
    self.0.add_friend(&name).await.map_err(js_error)
  }

  #[wasm_bindgen(js_name = removeFriend)]
  pub async fn remove_friend(&self, name: String) -> Result<(), JsValue> {
    self.0.remove_friend(&name).await.map_err(js_error)
  }

  #[wasm_bindgen(unchecked_return_type = "Session[]")]
  pub async fn dms(&self) -> Result<JsValue, JsValue> {
    done(self.0.dms()).await
  }

  #[wasm_bindgen(unchecked_return_type = "Login[]")]
  pub async fn logins(&self) -> Result<JsValue, JsValue> {
    done(self.0.logins()).await
  }

  #[wasm_bindgen(js_name = revokeLogin)]
  pub async fn revoke_login(&self, id: String) -> Result<(), JsValue> {
    self.0.revoke_login(&id).await.map_err(js_error)
  }

  /// Where the browser goes to sign in with GitHub, landing on the website's path `callback`.
  #[wasm_bindgen(js_name = signInUrl)]
  pub fn sign_in_url(&self, callback: String) -> String {
    self.0.sign_in_url(&callback)
  }

  #[wasm_bindgen(js_name = signOut)]
  pub async fn sign_out(&self) -> Result<(), JsValue> {
    self.0.sign_out().await.map_err(js_error)
  }

  #[wasm_bindgen(js_name = showOtp, unchecked_return_type = "OtpShown")]
  pub async fn show_otp(&self, code: String) -> Result<JsValue, JsValue> {
    done(self.0.show_otp(&code)).await
  }

  #[wasm_bindgen(js_name = approveOtp)]
  pub async fn approve_otp(&self, code: String) -> Result<(), JsValue> {
    self.0.approve_otp(&code).await.map_err(js_error)
  }

  #[wasm_bindgen(js_name = denyOtp)]
  pub async fn deny_otp(&self, code: String) -> Result<(), JsValue> {
    self.0.deny_otp(&code).await.map_err(js_error)
  }

  #[wasm_bindgen(unchecked_return_type = "Invite[]")]
  pub async fn invites(&self) -> Result<JsValue, JsValue> {
    done(self.0.invites()).await
  }

  #[wasm_bindgen(js_name = createInvite, unchecked_return_type = "Invite")]
  pub async fn create_invite(&self, invite: Ts<CreateInvite>) -> Result<JsValue, JsValue> {
    let invite = from_js(invite)?;
    done(self.0.create_invite(&invite)).await
  }

  #[wasm_bindgen(js_name = revokeInvite)]
  pub async fn revoke_invite(&self, code: String) -> Result<(), JsValue> {
    self.0.revoke_invite(&code).await.map_err(js_error)
  }

  #[wasm_bindgen(js_name = showInvite, unchecked_return_type = "InviteShown")]
  pub async fn show_invite(&self, code: String) -> Result<JsValue, JsValue> {
    done(self.0.show_invite(&code)).await
  }

  #[wasm_bindgen(js_name = acceptInvite, unchecked_return_type = "Accepted")]
  pub async fn accept_invite(&self, code: String) -> Result<JsValue, JsValue> {
    done(self.0.accept_invite(&code)).await
  }
}
