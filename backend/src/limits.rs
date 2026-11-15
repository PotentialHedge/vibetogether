//! The limits that keep one client or account from taking everything.

use std::{
  collections::HashMap,
  net::IpAddr,
  path::Path,
  sync::Mutex,
  time::{Duration, Instant},
};

use axum::http::{HeaderMap, StatusCode};

use crate::error::{Refusal, Result};

#[derive(Default)]
pub struct Limits {
  /// Signing in, per address.
  pub sign_ins: PerAddress,
  /// OTPs asked for, per address.
  pub otps: PerAddress,
  /// Invites looked up, per address.
  pub invites: PerAddress,
  added: Mutex<HashMap<String, Added>>,
  /// When one person last asked another to be friends.
  asks: Mutex<HashMap<(String, String), Instant>>,
}

/// What one account added to logs this hour.
struct Added {
  start: Instant,
  entries: u64,
  bytes: u64,
}

const HOUR: Duration = Duration::from_secs(3600);
const MAX_ENTRIES: u64 = 3000;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// What the disk keeps free beyond a payload.
const DISK_RESERVE: u64 = 1024 * 1024 * 1024;

/// The address a request came from, which the proxy in front sets as `X-Forwarded-For`, by the
/// network it counts by: an IPv4 address itself, and an IPv6 address's /64, which one client
/// holds whole.
pub fn address_of(headers: &HeaderMap) -> String {
  let given = headers
    .get("x-forwarded-for")
    .and_then(|v| v.to_str().ok())
    .and_then(|v| v.split(',').next())
    .map(str::trim)
    .unwrap_or_default();
  match given.parse::<IpAddr>() {
    Ok(IpAddr::V6(ip)) => {
      let s = ip.segments();
      format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
    }
    Ok(ip) => ip.to_string(),
    Err(_) if given.is_empty() => "an unknown address".to_string(),
    Err(_) => given.to_string(),
  }
}

/// At most `max` of something a minute from one address.
#[derive(Default)]
pub struct PerAddress(Mutex<HashMap<String, (Instant, u32)>>);

impl PerAddress {
  pub fn allow(&self, headers: &HeaderMap, max: u32) -> Result<()> {
    let mut seen = self.0.lock().unwrap();
    if seen.len() > 10_000 {
      seen.clear();
    }
    let now = Instant::now();
    let entry = seen.entry(address_of(headers)).or_insert((now, 0));
    if now.duration_since(entry.0) > Duration::from_secs(60) {
      *entry = (now, 0);
    }
    entry.1 += 1;
    if entry.1 > max {
      return Err(Refusal::busy(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many tries from this address: wait a minute.",
        60,
      ));
    }
    Ok(())
  }
}

impl Limits {
  /// Counts an entry of `bytes` that `account` adds to a log, such as a message, a join or a
  /// leave, or refuses it where the account added too much this hour or the disk is nearly full.
  pub fn adds(&self, account: &str, bytes: u64, database: &Path) -> Result<()> {
    let dir = database
      .parent()
      .filter(|d| !d.as_os_str().is_empty())
      .unwrap_or(Path::new("."));
    if let Ok(disk) = rustix::fs::statvfs(dir)
      && disk.f_bavail.saturating_mul(disk.f_frsize) < DISK_RESERVE + bytes
    {
      return Err(Refusal::busy(
        StatusCode::SERVICE_UNAVAILABLE,
        "The backend's disk is nearly full.",
        3600,
      ));
    }
    let mut added = self.added.lock().unwrap();
    let now = Instant::now();
    let count = added.entry(account.to_string()).or_insert(Added {
      start: now,
      entries: 0,
      bytes: 0,
    });
    if now.duration_since(count.start) > HOUR {
      *count = Added {
        start: now,
        entries: 0,
        bytes: 0,
      };
    }
    if count.entries + 1 > MAX_ENTRIES || count.bytes + bytes > MAX_BYTES {
      let left = HOUR.saturating_sub(now.duration_since(count.start));
      return Err(Refusal::busy(
        StatusCode::SERVICE_UNAVAILABLE,
        "This account added too much this hour.",
        left.as_secs() + 1,
      ));
    }
    count.entries += 1;
    count.bytes += bytes;
    Ok(())
  }

  /// Whether `from` asks `to` to be friends for the first time today, so that asking again and
  /// again tells them once a day.
  pub fn first_ask(&self, from: &str, to: &str) -> bool {
    let mut asks = self.asks.lock().unwrap();
    if asks.len() > 100_000 {
      asks.clear();
    }
    let key = (from.to_string(), to.to_string());
    if asks
      .get(&key)
      .is_some_and(|at| at.elapsed() < Duration::from_secs(86400))
    {
      return false;
    }
    asks.insert(key, Instant::now());
    true
  }
}
