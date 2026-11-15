//! Waiting for something an account sees to change, such as its overview or a session's log.
//! Every write wakes every waiter, which checks whether what it waits on differs now: no write
//! has to say what it changed, and sessions are assumed small.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::error::{Refusal, Result};

/// The most waits of one account at once.
const MAX_WAITS: usize = 64;

pub struct Changes {
  writes: watch::Sender<u64>,
  waits: Mutex<HashMap<String, usize>>,
}

impl Default for Changes {
  fn default() -> Self {
    Self {
      writes: watch::Sender::new(0),
      waits: Mutex::default(),
    }
  }
}

/// A short version of `value`, which differs wherever it does.
pub fn version_of(value: &impl Serialize) -> String {
  let json = serde_json::to_vec(value).unwrap_or_default();
  URL_SAFE_NO_PAD.encode(Sha256::digest(json))[..16].to_string()
}

/// One account's wait, counted while it lasts.
struct Wait<'a> {
  changes: &'a Changes,
  account: String,
}

impl Drop for Wait<'_> {
  fn drop(&mut self) {
    let mut waits = self.changes.waits.lock().unwrap();
    if let Some(n) = waits.get_mut(&self.account) {
      *n -= 1;
      if *n == 0 {
        waits.remove(&self.account);
      }
    }
  }
}

impl Changes {
  /// Wakes every waiter, once a write is done.
  pub fn written(&self) {
    self.writes.send_modify(|n| *n = n.wrapping_add(1));
  }

  /// The value of `current` once `differs` holds for it, or after `wait` seconds where given, or
  /// at once where it holds already or `wait` is 0. Dropping the future ends the wait.
  pub async fn changed<T, F: Future<Output = Result<T>> + Send>(
    &self,
    account: &str,
    current: impl Fn() -> F,
    differs: impl Fn(&T) -> bool,
    wait: Option<u64>,
  ) -> Result<T> {
    let mut writes = self.writes.subscribe();
    let now = current().await?;
    if differs(&now) || wait == Some(0) {
      return Ok(now);
    }
    let _wait = self.count(account)?;
    let timeout = async {
      match wait {
        Some(seconds) => tokio::time::sleep(Duration::from_secs(seconds)).await,
        None => std::future::pending().await,
      }
    };
    tokio::pin!(timeout);
    loop {
      tokio::select! {
        _ = writes.changed() => {
          let value = current().await?;
          if differs(&value) {
            return Ok(value);
          }
        }
        () = &mut timeout => return current().await,
      }
    }
  }

  fn count(&self, account: &str) -> Result<Wait<'_>> {
    let mut waits = self.waits.lock().unwrap();
    let n = waits.entry(account.to_string()).or_default();
    if *n >= MAX_WAITS {
      return Err(Refusal::busy(
        StatusCode::SERVICE_UNAVAILABLE,
        "This account has too many waits at once.",
        10,
      ));
    }
    *n += 1;
    Ok(Wait {
      changes: self,
      account: account.to_string(),
    })
  }
}
