//! The limits that keep one client or account from taking everything.

use std::{
  collections::HashMap,
  hash::Hash,
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
  /// Sends of one account at once, whose payloads are held in memory meanwhile.
  pub sends: Concurrent,
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

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(3600);
const DAY: Duration = Duration::from_secs(86400);
const MAX_ENTRIES: u64 = 3000;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// What the disk keeps free beyond a payload.
const DISK_RESERVE: u64 = 1024 * 1024 * 1024;

/// The address a request came from, which the proxy in front sets as `X-Forwarded-For`, by the
/// network it counts by: an IPv4 address itself, and an IPv6 address's /48, which one client
/// may hold whole.
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
      format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2])
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
    let address = address_of(headers);
    if !seen.contains_key(&address) {
      make_room(&mut seen, 10_000, MINUTE, |(at, _)| *at);
    }
    let now = Instant::now();
    let entry = seen.entry(address).or_insert((now, 0));
    if now.duration_since(entry.0) > MINUTE {
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

/// How many of something run at once, by whom.
#[derive(Default)]
pub struct Concurrent(Mutex<HashMap<String, usize>>);

/// One of something that runs, counted while it lasts.
pub struct Running<'a> {
  concurrent: &'a Concurrent,
  key: String,
}

impl Drop for Running<'_> {
  fn drop(&mut self) {
    let mut running = self.concurrent.0.lock().unwrap();
    if let Some(n) = running.get_mut(&self.key) {
      *n -= 1;
      if *n == 0 {
        running.remove(&self.key);
      }
    }
  }
}

impl Concurrent {
  /// Starts one more of `key`'s, or refuses with `message` where `max` run already.
  pub fn start(&self, key: &str, max: usize, message: &str) -> Result<Running<'_>> {
    let mut running = self.0.lock().unwrap();
    let n = running.entry(key.to_string()).or_default();
    if *n >= max {
      return Err(Refusal::busy(StatusCode::SERVICE_UNAVAILABLE, message, 10));
    }
    *n += 1;
    Ok(Running {
      concurrent: self,
      key: key.to_string(),
    })
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
    let key = (from.to_string(), to.to_string());
    if asks.get(&key).is_some_and(|at| at.elapsed() < DAY) {
      return false;
    }
    if !asks.contains_key(&key) {
      make_room(&mut asks, 100_000, DAY, |at| *at);
    }
    asks.insert(key, Instant::now());
    true
  }
}

/// Makes room in `map` for one more, so that it holds at most `max`: drops what is older than
/// `age`, as `at` dates it, and where that is not enough, the oldest.
fn make_room<K: Clone + Eq + Hash, V>(
  map: &mut HashMap<K, V>,
  max: usize,
  age: Duration,
  at: impl Fn(&V) -> Instant,
) {
  if map.len() < max {
    return;
  }
  map.retain(|_, v| at(v).elapsed() < age);
  if map.len() >= max
    && let Some(oldest) = map
      .iter()
      .min_by_key(|(_, v)| at(v))
      .map(|(k, _)| k.clone())
  {
    map.remove(&oldest);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_ipv6_address_counts_by_its_48() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "2001:db8:1:2::1".parse().unwrap());
    assert_eq!(address_of(&headers), "2001:db8:1::/48");
  }

  #[test]
  fn at_most_max_run_at_once_of_one_key() {
    let sends = Concurrent::default();
    let running: Vec<_> = (0..2)
      .map(|_| sends.start("u_1", 2, "busy").unwrap())
      .collect();
    assert!(sends.start("u_1", 2, "busy").is_err());
    assert!(sends.start("u_2", 2, "busy").is_ok());
    drop(running);
    assert!(sends.start("u_1", 2, "busy").is_ok());
    assert!(sends.0.lock().unwrap().is_empty());
  }

  #[test]
  fn a_full_map_drops_its_oldest_not_everything() {
    let start = Instant::now();
    let mut map: HashMap<u32, Instant> = (0..3)
      .map(|i| (i, start + Duration::from_secs(i.into())))
      .collect();
    make_room(&mut map, 3, DAY, |at| *at);
    let mut kept: Vec<_> = map.keys().copied().collect();
    kept.sort();
    assert_eq!(kept, [1, 2]);
  }
}
