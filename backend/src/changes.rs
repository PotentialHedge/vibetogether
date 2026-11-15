//! Waiting for something an account sees to change, such as its overview or a session's log.
//! Every write wakes every waiter, which checks whether what it waits on differs now: no write
//! has to say what it changed, and sessions are assumed small. A waiter checks at most every
//! `SETTLE`, once for all the writes meanwhile, so that a burst of writes costs it one check.

use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::{error::Result, limits::Concurrent};

/// The most waits of one account at once.
const MAX_WAITS: usize = 64;
/// How long a waiter lets the writes settle before it checks.
const SETTLE: Duration = Duration::from_millis(100);

pub struct Changes {
  writes: watch::Sender<u64>,
  waits: Concurrent,
}

impl Default for Changes {
  fn default() -> Self {
    Self {
      writes: watch::Sender::new(0),
      waits: Concurrent::default(),
    }
  }
}

/// A short version of `value`, which differs wherever it does.
pub fn version_of(value: &impl Serialize) -> String {
  let json = serde_json::to_vec(value).unwrap_or_default();
  URL_SAFE_NO_PAD.encode(Sha256::digest(json))[..16].to_string()
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
    let _wait = self.waits.start(
      account,
      MAX_WAITS,
      "This account has too many waits at once.",
    )?;
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
          tokio::time::sleep(SETTLE).await;
          writes.borrow_and_update();
          let value = current().await?;
          if differs(&value) {
            return Ok(value);
          }
        }
        () = &mut timeout => return current().await,
      }
    }
  }
}
