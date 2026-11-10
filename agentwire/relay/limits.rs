//! What one client may take of the relay, so that no one fills its disk or
//! holds all its connections.
//!
//! A client is the address that reached the relay, or, from the relay's own
//! machine, the one a proxy there names last in `X-Forwarded-For`. A request
//! from the machine that names none is the machine's own, such as a service
//! beside the relay, and isn't limited. An IPv6 client is its /64, which one
//! host usually holds whole.

use std::collections::HashMap;
use std::ffi::CString;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::Instant;

use axum::http::HeaderMap;

/// What a client may add at once, in bytes. A request that adds something, a
/// session, a participant or an entry, counts `COST` on top of its payload.
const BURST: f64 = 100e6;
/// What a client may add each second after that.
const RATE: f64 = 50e3;
pub const COST: u64 = 16 * 1024;
/// How many receives one client may have waiting at once.
const RECEIVES: usize = 256;
/// How many clients are kept before those that took nothing for a while are
/// forgotten.
const KEPT: usize = 4096;

/// The client that sent a request, or none where it is the relay's own machine.
pub fn client(peer: Option<SocketAddr>, headers: &HeaderMap) -> Option<IpAddr> {
    let address = match peer {
        Some(peer) if !peer.ip().is_loopback() => peer.ip(),
        _ => headers
            .get_all("x-forwarded-for")
            .iter()
            .next_back()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit(',').next())
            .and_then(|value| value.trim().parse().ok())?,
    };
    Some(match address {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let [a, b, c, d, ..] = v6.segments();
                IpAddr::V6(Ipv6Addr::new(a, b, c, d, 0, 0, 0, 0))
            }
        },
        v4 => v4,
    })
}

/// The bytes free to the relay on the filesystem `path` is on.
pub fn free(path: &Path) -> Option<u64> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: the path is a C string, and statvfs fills `stat` where it succeeds.
    let stat = unsafe {
        if libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) != 0 {
            return None;
        }
        stat.assume_init()
    };
    #[allow(clippy::unnecessary_cast)]
    Some(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[derive(Default)]
pub struct Limits {
    clients: HashMap<IpAddr, Usage>,
}

struct Usage {
    /// What it may still add, as of `at`.
    room: f64,
    at: Instant,
    receives: usize,
}

impl Usage {
    fn room(&self, now: Instant) -> f64 {
        (self.room + now.duration_since(self.at).as_secs_f64() * RATE).min(BURST)
    }
}

impl Limits {
    fn usage(&mut self, client: IpAddr, now: Instant) -> &mut Usage {
        if self.clients.len() >= KEPT {
            self.clients
                .retain(|_, usage| usage.receives > 0 || usage.room(now) < BURST);
        }
        self.clients.entry(client).or_insert(Usage {
            room: BURST,
            at: now,
            receives: 0,
        })
    }

    /// Takes `bytes` of what `client` may add, or says in how many seconds it may.
    pub fn take(&mut self, client: IpAddr, bytes: u64) -> Result<(), u64> {
        let now = Instant::now();
        let usage = self.usage(client, now);
        let (room, bytes) = (usage.room(now), bytes as f64);
        if room < bytes {
            return Err(((bytes - room) / RATE).ceil() as u64);
        }
        usage.room = room - bytes;
        usage.at = now;
        Ok(())
    }

    /// Counts a receive of `client` as waiting, unless it has too many.
    pub fn wait(&mut self, client: IpAddr) -> bool {
        let usage = self.usage(client, Instant::now());
        let room = usage.receives < RECEIVES;
        usage.receives += usize::from(room);
        room
    }

    /// Counts a receive of `client` as no longer waiting.
    pub fn waited(&mut self, client: IpAddr) {
        if let Some(usage) = self.clients.get_mut(&client) {
            usage.receives = usage.receives.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forwarded(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", value.parse().unwrap());
        headers
    }

    #[test]
    fn a_client_is_the_peer_or_whom_a_local_proxy_names() {
        let local = Some("127.0.0.1:1".parse().unwrap());
        let remote = Some("203.0.113.9:1".parse().unwrap());
        assert_eq!(client(local, &HeaderMap::new()), None);
        assert_eq!(
            client(local, &forwarded("198.51.100.1, 203.0.113.7")),
            Some("203.0.113.7".parse().unwrap())
        );
        assert_eq!(
            client(remote, &forwarded("198.51.100.1")),
            Some("203.0.113.9".parse().unwrap())
        );
        assert_eq!(
            client(local, &forwarded("2001:db8:1:2:3:4:5:6")),
            Some("2001:db8:1:2::".parse().unwrap())
        );
    }

    #[test]
    fn a_client_adds_its_burst_and_then_waits() {
        let mut limits = Limits::default();
        let one: IpAddr = "203.0.113.1".parse().unwrap();
        assert_eq!(limits.take(one, BURST as u64), Ok(()));
        assert!(limits.take(one, 10 * RATE as u64).unwrap_err() >= 9);
        assert_eq!(limits.take("203.0.113.2".parse().unwrap(), COST), Ok(()));
    }

    #[test]
    fn a_client_keeps_only_so_many_receives_waiting() {
        let mut limits = Limits::default();
        let one: IpAddr = "203.0.113.1".parse().unwrap();
        for _ in 0..RECEIVES {
            assert!(limits.wait(one));
        }
        assert!(!limits.wait(one));
        limits.waited(one);
        assert!(limits.wait(one));
    }
}
