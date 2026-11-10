//! Every session: its log and its participants in SQLite, and the receives
//! waiting on it in memory.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::{Connection, OptionalExtension, Row, params};
use tokio::sync::oneshot;

use agentwire::{Entry, JOIN, Joined, LEAVE, Presence, Received};

use crate::{Fail, fail};

pub const MAX_NAME: usize = 256;

/// What a name is, said in the answer to a join under any other.
pub const NAME_RULE: &str = "a name is lower case, with hyphens for spaces, as <person> \
     or <person>/<agent>: one or two parts of letters a-z, digits and hyphens, \
     each starting with a letter or digit, joined by one /, such as luis or luis/claude";

/// Whether `name` is a name: one part, or two joined by `/`, each of
/// lower-case letters, digits and hyphens, starting with a letter or digit.
/// So no name looks like another, and none is `*` or holds quotes or spaces.
pub fn is_name(name: &str) -> bool {
    let part = |p: &str| {
        p.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    match name.split_once('/') {
        Some((person, agent)) => part(person) && part(agent),
        None => part(name),
    }
}
const MAX_INLINE: usize = 64 * 1024;
/// The entries one answer holds at most, in bytes, past which the next
/// receive returns the rest; an answer holds at least one.
const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// How long a session that nobody joined lasts, in seconds.
const UNJOINED: i64 = 24 * 60 * 60;
/// How long a session lasts once nobody receives in it, in seconds.
const UNRECEIVED: i64 = 7 * 24 * 60 * 60;
/// How long a participant counts as live after its last receive ended: past
/// it, its account may take its name back, so that a crashed one's comes free.
const LIVE: i64 = 60 * 60;

const SCHEMA: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created INTEGER NOT NULL,
        received INTEGER NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS entries (
        session TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
        n INTEGER NOT NULL,
        time TEXT NOT NULL,
        sender TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        filename TEXT,
        text TEXT,
        payload BLOB,
        account TEXT,
        PRIMARY KEY (session, n)
    );
    CREATE TABLE IF NOT EXISTS participants (
        session TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        inside INTEGER NOT NULL,
        entry INTEGER NOT NULL,
        read INTEGER NOT NULL,
        since TEXT NOT NULL,
        token TEXT,
        account TEXT,
        PRIMARY KEY (session, name),
        UNIQUE (session, secret)
    );
";

pub struct Sessions {
    db: Connection,
    /// The receives still waiting, by session and name: one per participant.
    waiting: HashMap<String, BTreeMap<String, Waiting>>,
    /// The receives answered but not yet handed over, by session, name and
    /// receive, with whether each waited for presence: see `settle`.
    answered: HashMap<(String, String, u64), bool>,
    receives: u64,
}

/// What a receive asks for.
pub struct Receive {
    /// The entries after this number, or with none, after the caller's read
    /// position.
    pub after: Option<i64>,
    /// The position it acknowledges, if not `after`'s.
    pub read: Option<i64>,
    pub own: bool,
    pub presence: bool,
    /// The starts of the types it asks for, in lower case; with none, every
    /// type.
    pub only: Vec<String>,
    /// The starts of the types it skips, in lower case.
    pub skip: Vec<String>,
}

impl Receive {
    /// Whether entries of `kind` are returned, and end its wait: the rest
    /// do neither.
    fn wants(&self, kind: &str) -> bool {
        let kind = kind.to_ascii_lowercase();
        let matches =
            |starts: &[String]| starts.iter().any(|start| kind.starts_with(start.as_str()));
        (self.only.is_empty() || matches(&self.only)) && !matches(&self.skip)
    }
}

struct Waiting {
    id: u64,
    /// The receive's `after`, resolved.
    after: i64,
    receive: Receive,
    answer: oneshot::Sender<Answer>,
}

pub enum Answer {
    /// The lines, and the read position they acknowledge, which the relay sets
    /// once the access service still lets the caller in.
    Lines(String, Option<i64>),
    Replaced,
    /// Its name's account took the name back.
    TakenBack,
}

/// One waiting receive, as its caller holds it.
pub struct Ticket {
    session: String,
    name: String,
    id: u64,
}

/// Whoever holds a name, as a join under it finds them.
pub struct Holder {
    pub inside: bool,
    pub token: Option<String>,
    pub account: Option<String>,
    pub live: bool,
}

struct Participant {
    name: String,
    inside: bool,
    entry: i64,
    read: i64,
}

pub struct Payload {
    pub kind: String,
    pub filename: Option<String>,
    pub body: Vec<u8>,
}

/// A secret of 128 random bits: a session's address, or a participant's own part
/// of the session's link.
fn secret() -> String {
    let mut random = [0; 16];
    getrandom::fill(&mut random).expect("the system has randomness");
    URL_SAFE_NO_PAD.encode(random)
}

pub fn is_secret(text: &str) -> bool {
    text.len() == 22
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Text the log carries inline: `text/*`, JSON and `+json`, whatever the
/// parameters.
fn textual(kind: &str) -> bool {
    let base = kind
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    base.starts_with("text/") || base == "application/json" || base.ends_with("+json")
}

fn participant(row: &Row) -> rusqlite::Result<Participant> {
    Ok(Participant {
        name: row.get("name")?,
        inside: row.get("inside")?,
        entry: row.get("entry")?,
        read: row.get("read")?,
    })
}

impl Sessions {
    /// The sessions in the database at `path`, or in memory without one.
    pub fn open(path: Option<&Path>) -> rusqlite::Result<Self> {
        let db = match path {
            Some(path) => Connection::open(path)?,
            None => Connection::open_in_memory()?,
        };
        // A database from before sessions lived while anyone is in them.
        if db
            .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'used'")?
            .exists([])?
        {
            db.execute("ALTER TABLE sessions RENAME COLUMN used TO created", [])?;
        }
        db.execute_batch(SCHEMA)?;
        // A database from before a session ended once nobody received in it.
        if !db
            .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'received'")?
            .exists([])?
        {
            db.execute_batch(
                "ALTER TABLE sessions ADD COLUMN received INTEGER NOT NULL DEFAULT 0;
                 UPDATE sessions SET received = created;",
            )?;
        }
        // A database from before participants joined with tokens.
        if !db
            .prepare("SELECT 1 FROM pragma_table_info('participants') WHERE name = 'token'")?
            .exists([])?
        {
            db.execute("ALTER TABLE participants ADD COLUMN token TEXT", [])?;
        }
        if !db
            .prepare("SELECT 1 FROM pragma_table_info('participants') WHERE name = 'account'")?
            .exists([])?
        {
            db.execute("ALTER TABLE participants ADD COLUMN account TEXT", [])?;
        }
        // A database from before entries carried their sender's account.
        if !db
            .prepare("SELECT 1 FROM pragma_table_info('entries') WHERE name = 'account'")?
            .exists([])?
        {
            db.execute("ALTER TABLE entries ADD COLUMN account TEXT", [])?;
        }
        // A database from before owned sessions were called owned.
        let column = |name: &str| -> rusqlite::Result<bool> {
            db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = ?")?
                .exists([name])
        };
        if column("guarded")? {
            db.execute("ALTER TABLE sessions RENAME COLUMN guarded TO owned", [])?;
        } else if !column("owned")? {
            db.execute(
                "ALTER TABLE sessions ADD COLUMN owned INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(Self {
            db,
            waiting: HashMap::new(),
            answered: HashMap::new(),
            receives: 0,
        })
    }

    /// A new session, owned or not: only an owned one depends on the access service.
    pub fn create(&mut self, owned: bool) -> Result<String, Fail> {
        let id = secret();
        self.db.execute(
            "INSERT INTO sessions (id, created, received, owned)
             VALUES (?, unixepoch(), unixepoch(), ?)",
            params![id, owned],
        )?;
        Ok(id)
    }

    /// Whether the session was created owned; no for one that doesn't exist.
    pub fn owned(&self, session: &str) -> Result<bool, Fail> {
        let owned = self
            .db
            .prepare_cached("SELECT owned FROM sessions WHERE id = ?")?
            .query_row([session], |row| row.get(0))
            .optional()?;
        Ok(owned.unwrap_or(false))
    }

    /// Fails unless the session exists.
    pub fn enter(&self, session: &str) -> Result<(), Fail> {
        let exists = self
            .db
            .prepare_cached("SELECT 1 FROM sessions WHERE id = ?")?
            .exists([session])?;
        if !exists {
            return Err(fail(404, "no such session"));
        }
        Ok(())
    }

    /// The sessions due to end: every one that nobody joined within
    /// `UNJOINED` of its creation, every one that nobody received in for
    /// `UNRECEIVED`, and every one that everyone left.
    pub fn expiring(&mut self) -> Result<Vec<String>, Fail> {
        self.expiring_after(UNJOINED, UNRECEIVED)
    }

    fn expiring_after(&mut self, unjoined: i64, unreceived: i64) -> Result<Vec<String>, Fail> {
        let due = self
            .db
            .prepare(
                "SELECT id FROM sessions WHERE received <= unixepoch() - ?2
                 OR (NOT EXISTS (SELECT 1 FROM participants WHERE session = id AND inside)
                     AND (created <= unixepoch() - ?1
                          OR EXISTS (SELECT 1 FROM participants WHERE session = id)))",
            )?
            .query_map([unjoined, unreceived], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut expiring = Vec::new();
        for session in due {
            // A receive still waiting is someone receiving now.
            if self.waiting.contains_key(&session) {
                self.received(&session)?;
            } else {
                expiring.push(session);
            }
        }
        Ok(expiring)
    }

    /// Marks that someone received in the session, which keeps it for
    /// another `UNRECEIVED`.
    fn received(&self, session: &str) -> Result<(), Fail> {
        self.db
            .prepare_cached("UPDATE sessions SET received = unixepoch() WHERE id = ?")?
            .execute([session])?;
        Ok(())
    }

    /// Deletes the session, payloads and all. Receives still waiting return.
    pub fn end(&mut self, session: &str) -> Result<(), Fail> {
        self.db
            .execute("DELETE FROM sessions WHERE id = ?", [session])?;
        for name in self.names_waiting(session) {
            self.answer(session, &name)?;
        }
        Ok(())
    }

    fn caller(&self, session: &str, secret: &str) -> Result<Participant, Fail> {
        self.db
            .prepare_cached("SELECT * FROM participants WHERE session = ? AND secret = ?")?
            .query_row([session, secret], participant)
            .optional()?
            .ok_or_else(|| fail(403, "this link is no participant's"))
    }

    /// The caller's name, the token it joined with, and the account vouched for.
    pub fn credentials(
        &self,
        session: &str,
        secret: &str,
    ) -> Result<(String, Option<String>, Option<String>), Fail> {
        self.db
            .prepare_cached(
                "SELECT name, token, account FROM participants WHERE session = ? AND secret = ?",
            )?
            .query_row([session, secret], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()?
            .ok_or_else(|| fail(403, "this link is no participant's"))
    }

    /// Keeps `token` as the one the caller presents from now on, and `account`
    /// as the one the access service vouches for.
    pub fn vouch(
        &self,
        session: &str,
        secret: &str,
        token: Option<&str>,
        account: Option<&str>,
    ) -> Result<(), Fail> {
        self.db
            .prepare_cached(
                "UPDATE participants SET token = coalesce(?, token), account = ?
                 WHERE session = ? AND secret = ?",
            )?
            .execute(params![token, account, session, secret])?;
        Ok(())
    }

    /// The caller, if it is in the session.
    pub fn inside(&self, session: &str, secret: &str) -> Result<String, Fail> {
        let caller = self.caller(session, secret)?;
        if !caller.inside {
            return Err(fail(
                403,
                "you have left: join again with POST <your link>/join",
            ));
        }
        Ok(caller.name)
    }

    fn is_inside(&self, session: &str, name: &str) -> rusqlite::Result<bool> {
        Ok(self
            .db
            .prepare_cached("SELECT inside FROM participants WHERE session = ? AND name = ?")?
            .query_row([session, name], |row| row.get(0))
            .optional()?
            .unwrap_or(false))
    }

    /// Takes `name` for the caller, who gets a link of its own: a name is
    /// bound to whoever joined with it, for the whole session.
    pub fn join(
        &mut self,
        session: &str,
        name: Option<&str>,
        link: &str,
        presented: Option<&str>,
        account: Option<&str>,
        take_back: bool,
    ) -> Result<Joined, Fail> {
        let name = name
            .filter(|name| !name.is_empty())
            .ok_or_else(|| fail(400, "name yourself with ?as=<name>"))?;
        if name.len() > MAX_NAME {
            return Err(fail(400, format!("a name is at most {MAX_NAME} bytes")));
        }
        if !is_name(name) {
            return Err(fail(400, NAME_RULE));
        }
        let secret = secret();
        let transaction = self.db.unchecked_transaction()?;
        let taken = transaction
            .prepare_cached("SELECT 1 FROM participants WHERE session = ? AND name = ?")?
            .exists([session, name])?;
        // The relay decided whether the name is taken back: its holder
        // leaves, and its link is no participant's any more.
        if taken && !take_back {
            return Err(fail(
                409,
                format!("{name} is taken in this session: join under another name"),
            ));
        }
        if taken {
            let inside: bool = transaction
                .prepare_cached("SELECT inside FROM participants WHERE session = ? AND name = ?")?
                .query_row([session, name], |row| row.get(0))?;
            if inside {
                self.append(session, name, LEAVE, &[], None)?;
            }
            transaction.execute(
                "DELETE FROM participants WHERE session = ? AND name = ?",
                [session, name],
            )?;
        }
        let n = self.append(session, name, JOIN, &[], None)?;
        transaction.execute(
            "INSERT INTO participants (session, name, secret, inside, entry, read, since, token, account)
             VALUES (?, ?, ?, TRUE, ?, 0, strftime('%Y-%m-%dT%H:%M:%SZ'), ?, ?)",
            params![session, name, secret, n, presented, account],
        )?;
        transaction.execute(
            "UPDATE entries SET account = ? WHERE session = ? AND n = ?",
            params![account, session, n],
        )?;
        transaction.commit()?;
        // The receive its holder still waits on.
        if taken && let Some(waiting) = self.take(session, name) {
            _ = waiting.answer.send(Answer::TakenBack);
        }
        self.look(session)?;
        Ok(Joined {
            n: n as u64,
            name: name.to_owned(),
            read: 0,
            link: format!("{link}/{secret}"),
        })
    }

    /// Who holds `name` in `session`, if anyone: whether it is in, the token
    /// it joined with, the account vouched for it, and whether it is live,
    /// receiving now or within `LIVE` of its last receive.
    pub fn holder(&self, session: &str, name: &str) -> Result<Option<Holder>, Fail> {
        let receiving = self
            .waiting
            .get(session)
            .is_some_and(|waiting| waiting.contains_key(name));
        Ok(self
            .db
            .prepare_cached(
                "SELECT inside, token, account,
                        since > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?3)
                 FROM participants WHERE session = ?1 AND name = ?2",
            )?
            .query_row(params![session, name, format!("-{LIVE} seconds")], |row| {
                Ok(Holder {
                    inside: row.get(0)?,
                    token: row.get(1)?,
                    account: row.get(2)?,
                    live: receiving || row.get::<_, bool>(3)?,
                })
            })
            .optional()?)
    }

    /// Joins again, after leaving, under the name the link is bound to.
    pub fn rejoin(&mut self, session: &str, secret: &str, me: &str) -> Result<Joined, Fail> {
        let caller = self.caller(session, secret)?;
        let mut n = caller.entry;
        if !caller.inside {
            let transaction = self.db.unchecked_transaction()?;
            n = self.append(session, &caller.name, JOIN, &[], None)?;
            transaction.execute(
                "UPDATE participants SET inside = TRUE, entry = ?, since = strftime('%Y-%m-%dT%H:%M:%SZ')
                 WHERE session = ? AND name = ?",
                params![n, session, caller.name],
            )?;
            transaction.commit()?;
            self.look(session)?;
        }
        Ok(Joined {
            n: n as u64,
            name: caller.name,
            read: caller.read as u64,
            link: me.to_owned(),
        })
    }

    /// Leaves, and says whether anyone is still in: the caller ends a
    /// session that nobody is in any more, or keeps an owned one its service still knows.
    pub fn leave(&mut self, session: &str, secret: &str) -> Result<(i64, bool), Fail> {
        let caller = self.caller(session, secret)?;
        if !caller.inside {
            return Ok((caller.entry, true));
        }
        let transaction = self.db.unchecked_transaction()?;
        let n = self.append(session, &caller.name, LEAVE, &[], None)?;
        transaction.execute(
            "UPDATE participants SET inside = FALSE, entry = ? WHERE session = ? AND name = ?",
            params![n, session, caller.name],
        )?;
        transaction.commit()?;
        self.look(session)?;
        let anyone = self
            .db
            .prepare_cached("SELECT 1 FROM participants WHERE session = ? AND inside")?
            .exists([session])?;
        Ok((n, anyone))
    }

    pub fn send(
        &mut self,
        session: &str,
        secret: &str,
        kind: &str,
        filename: Option<&str>,
        payload: &[u8],
    ) -> Result<i64, Fail> {
        let name = self.inside(session, secret)?;
        let n = self.append(session, &name, kind, payload, filename)?;
        self.look(session)?;
        Ok(n)
    }

    /// Appends an entry, with its payload inline as text where it is short
    /// text, and as bytes otherwise.
    fn append(
        &self,
        session: &str,
        sender: &str,
        kind: &str,
        payload: &[u8],
        filename: Option<&str>,
    ) -> rusqlite::Result<i64> {
        let text = (textual(kind) && payload.len() <= MAX_INLINE)
            .then(|| std::str::from_utf8(payload).ok())
            .flatten()
            .map(|text| text.strip_prefix('\u{feff}').unwrap_or(text));
        let bytes = (text.is_none() && !payload.is_empty()).then_some(payload);
        self.db
            .prepare_cached(
                "INSERT INTO entries (session, n, time, sender, type, size, filename, text, payload, account)
                 VALUES (?1, (SELECT COALESCE(MAX(n), 0) + 1 FROM entries WHERE session = ?1),
                         strftime('%Y-%m-%dT%H:%M:%SZ'), ?2, ?3, ?4, ?5, ?6, ?7,
                         (SELECT account FROM participants WHERE session = ?1 AND name = ?2))
                 RETURNING n",
            )?
            .query_row(
                params![session, sender, kind, payload.len() as i64, filename, text, bytes],
                |row| row.get(0),
            )
    }

    pub fn payload(&self, session: &str, secret: &str, n: i64) -> Result<Payload, Fail> {
        self.inside(session, secret)?;
        self.db
            .prepare_cached(
                "SELECT type, filename, COALESCE(CAST(text AS BLOB), payload, X'') FROM entries
                 WHERE session = ? AND n = ?",
            )?
            .query_row(params![session, n], |row| {
                Ok(Payload {
                    kind: row.get(0)?,
                    filename: row.get(1)?,
                    body: row.get(2)?,
                })
            })
            .optional()?
            .ok_or_else(|| fail(404, "no such entry"))
    }

    /// Starts a receive, which is answered once it has something to return.
    /// Receiving after `n` moves the read position up to `n`, or up to `read`
    /// if given, never beyond the last entry; with no `n`, it receives after
    /// the read position.
    pub fn receive(
        &mut self,
        session: &str,
        secret: &str,
        receive: Receive,
    ) -> Result<(Ticket, oneshot::Receiver<Answer>), Fail> {
        let name = self.inside(session, secret)?;
        self.received(session)?;
        let after = match receive.after {
            Some(after) => after,
            None => self
                .db
                .prepare_cached("SELECT read FROM participants WHERE session = ? AND name = ?")?
                .query_row(params![session, name], |row| row.get(0))?,
        };
        let last: i64 = self
            .db
            .prepare_cached("SELECT COALESCE(MAX(n), 0) FROM entries WHERE session = ?")?
            .query_row([session], |row| row.get(0))?;
        let read = receive.read.unwrap_or(after);
        let moved = self.db.execute(
            "UPDATE participants SET read = ?1 WHERE session = ?2 AND name = ?3 AND read < ?1",
            params![read.min(last), session, name],
        )?;
        if moved > 0 {
            self.stir(session, &name)?;
        }

        self.receives += 1;
        let id = self.receives;
        let presence = receive.presence;
        let (answer, answered) = oneshot::channel();
        let replaced = self.waiting.entry(session.to_owned()).or_default().insert(
            name.clone(),
            Waiting {
                id,
                after,
                receive,
                answer,
            },
        );
        // A receive answered at once stirs the others only as it ends, so that
        // the presence they get shows what it read.
        let ready = self.ready(session, &name)?;
        match replaced {
            Some(replaced) => _ = replaced.answer.send(Answer::Replaced),
            None if !presence && !ready => self.stir(session, &name)?,
            None => {}
        }
        if ready {
            self.answer(session, &name)?;
        }
        let ticket = Ticket {
            session: session.to_owned(),
            name,
            id,
        };
        Ok((ticket, answered))
    }

    /// Answers a receive now, as when its wait has passed.
    pub fn answer_now(&mut self, ticket: &Ticket) -> Result<(), Fail> {
        if self.holds(ticket) {
            self.answer(&ticket.session, &ticket.name)?;
        }
        Ok(())
    }

    /// Ends an answered receive as its answer is handed over, or isn't: sets
    /// its caller's read position to what the answer acknowledged, if given,
    /// and only then tells the others, so that a read position moves only for
    /// what reached its participant.
    pub fn settle(&mut self, ticket: &Ticket, read: Option<i64>) -> Result<(), Fail> {
        let key = (ticket.session.clone(), ticket.name.clone(), ticket.id);
        let Some(presence) = self.answered.remove(&key) else {
            return Ok(());
        };
        if let Some(read) = read {
            self.db.execute(
                "UPDATE participants SET read = ?1 WHERE session = ?2 AND name = ?3 AND read < ?1",
                params![read, ticket.session, ticket.name],
            )?;
        }
        self.finish(&ticket.session, &ticket.name, presence)
    }

    /// Drops a receive whose caller went away.
    pub fn abandon(&mut self, ticket: &Ticket) -> Result<(), Fail> {
        if self.holds(ticket)
            && let Some(waiting) = self.take(&ticket.session, &ticket.name)
        {
            self.finish(&ticket.session, &ticket.name, waiting.receive.presence)?;
        }
        self.settle(ticket, None)
    }

    fn holds(&self, ticket: &Ticket) -> bool {
        self.waiting
            .get(&ticket.session)
            .and_then(|waiting| waiting.get(&ticket.name))
            .is_some_and(|waiting| waiting.id == ticket.id)
    }

    fn take(&mut self, session: &str, name: &str) -> Option<Waiting> {
        let waiting = self.waiting.get_mut(session)?;
        let taken = waiting.remove(name);
        if waiting.is_empty() {
            self.waiting.remove(session);
        }
        taken
    }

    fn names_waiting(&self, session: &str) -> Vec<String> {
        self.waiting
            .get(session)
            .map(|waiting| waiting.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Whether a receive has something to return: entries, or that its
    /// participant is no longer inside.
    fn ready(&self, session: &str, name: &str) -> rusqlite::Result<bool> {
        let Some(waiting) = self.waiting.get(session).and_then(|w| w.get(name)) else {
            return Ok(false);
        };
        if !self.is_inside(session, name)? {
            return Ok(true);
        }
        let mut kinds = self.db.prepare_cached(
            "SELECT type FROM entries WHERE session = ? AND n > ? AND (? OR sender != ?) ORDER BY n",
        )?;
        let mut rows = kinds.query(params![session, waiting.after, waiting.receive.own, name])?;
        while let Some(row) = rows.next()? {
            if waiting.receive.wants(&row.get::<_, String>(0)?) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Answers `name`'s receive with the entries it asks for, and the
    /// presence last.
    fn answer(&mut self, session: &str, name: &str) -> Result<(), Fail> {
        self.answer_all(session, &[name.to_owned()])
    }

    /// Answers the receives of `names` together: they all carry the presence
    /// from before any of them ended, so that none shows another as gone
    /// only because the same operation answered it first.
    fn answer_all(&mut self, session: &str, names: &[String]) -> Result<(), Fail> {
        let mut answers = Vec::new();
        for name in names {
            if let Some((lines, read)) = self.entries_for(session, name)? {
                answers.push((name, lines, read));
            }
        }
        let presence = self.presence(session)?;
        for (name, mut lines, read) in answers {
            // Its own presence shows what it acknowledges, as it will be.
            let mut presence = presence.clone();
            if let (Some(read), Some(own)) = (read, presence.get_mut(name.as_str())) {
                own.read = own.read.max(read as u64);
            }
            lines += &Received::presence_line(&presence);
            lines.push('\n');
            if let Some(waiting) = self.take(session, name) {
                let key = (session.to_owned(), name.clone(), waiting.id);
                self.answered.insert(key, waiting.receive.presence);
                _ = waiting.answer.send(Answer::Lines(lines, read));
            }
        }
        Ok(())
    }

    /// The entries `name`'s waiting receive asks for, one line each, and the
    /// read position that acknowledges them, if it does; none if it isn't waiting.
    fn entries_for(
        &mut self,
        session: &str,
        name: &str,
    ) -> Result<Option<(String, Option<i64>)>, Fail> {
        let Some(waiting) = self.waiting.get(session).and_then(|w| w.get(name)) else {
            return Ok(None);
        };
        let mut lines = String::new();
        let mut read = None;
        if self.is_inside(session, name)? {
            let (after, own) = (waiting.after, waiting.receive.own);
            let mut entries = self.db.prepare_cached(
                "SELECT n, time, sender, type, size, filename, text, account FROM entries
                 WHERE session = ? AND n > ? AND (? OR sender != ?) ORDER BY n",
            )?;
            let mut rows = entries.query(params![session, after, own, name])?;
            let mut cut = None;
            while let Some(row) = rows.next()? {
                if lines.len() >= MAX_ANSWER {
                    cut = Some(row.get::<_, i64>(0)? - 1);
                    break;
                }
                if !waiting.receive.wants(&row.get::<_, String>(3)?) {
                    continue;
                }
                let entry = Entry {
                    n: row.get(0)?,
                    time: row.get(1)?,
                    from: row.get(2)?,
                    kind: row.get(3)?,
                    size: row.get(4)?,
                    filename: row.get(5)?,
                    text: row.get(6)?,
                    account: row.get(7)?,
                };
                lines += &serde_json::to_string(&entry).expect("an entry is JSON");
                lines.push('\n');
            }
            drop(rows);
            drop(entries);
            // A receive from the read position acknowledges what it returns,
            // and what it leaves out, since its caller keeps no position of its
            // own; one that says what it read acknowledges only that.
            // A cut answer acknowledges only up to its cut.
            if waiting.receive.after.is_none() && waiting.receive.read.is_none() {
                read = match cut {
                    Some(cut) => Some(cut),
                    None => Some(
                        self.db
                            .prepare_cached(
                                "SELECT COALESCE(MAX(n), 0) FROM entries WHERE session = ?",
                            )?
                            .query_row([session], |row| row.get(0))?,
                    ),
                };
            }
        }
        Ok(Some((lines, read)))
    }

    /// Ends a receive: its participant is no longer receiving.
    fn finish(&mut self, session: &str, name: &str, presence: bool) -> Result<(), Fail> {
        self.db.execute(
            "UPDATE participants SET since = strftime('%Y-%m-%dT%H:%M:%SZ') WHERE session = ? AND name = ?",
            [session, name],
        )?;
        if !presence {
            self.stir(session, name)?;
        }
        Ok(())
    }

    /// Answers the receives that have something to return, once an operation
    /// is done, so that the presence says what it did.
    fn look(&mut self, session: &str) -> Result<(), Fail> {
        let mut ready = Vec::new();
        for name in self.names_waiting(session) {
            if self.ready(session, &name)? {
                ready.push(name);
            }
        }
        self.answer_all(session, &ready)
    }

    /// Answers the receives waiting for presence, except `by`'s own.
    fn stir(&mut self, session: &str, by: &str) -> Result<(), Fail> {
        let stirred: Vec<String> = self
            .waiting
            .get(session)
            .into_iter()
            .flatten()
            .filter(|(name, waiting)| waiting.receive.presence && name.as_str() != by)
            .map(|(name, _)| name.clone())
            .collect();
        self.answer_all(session, &stirred)
    }

    fn presence(&self, session: &str) -> rusqlite::Result<BTreeMap<String, Presence>> {
        let waiting = self.waiting.get(session);
        self.db
            .prepare_cached(
                "SELECT name, read, since, account FROM participants WHERE session = ? AND inside",
            )?
            .query_map([session], |row| {
                let name: String = row.get(0)?;
                let receiving = waiting.is_some_and(|waiting| waiting.contains_key(&name));
                let presence = Presence {
                    read: row.get(1)?,
                    receiving,
                    since: if receiving { None } else { row.get(2)? },
                    account: row.get(3)?,
                };
                Ok((name, presence))
            })?
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Sessions {
        fn expire_after(&mut self, unjoined: i64, unreceived: i64) -> Result<(), Fail> {
            for session in self.expiring_after(unjoined, unreceived)? {
                self.end(&session)?;
            }
            Ok(())
        }
    }

    #[test]
    fn only_a_session_nobody_joined_expires() {
        let mut sessions = Sessions::open(None).unwrap();
        let unjoined = sessions.create(false).ok().unwrap();
        let joined = sessions.create(false).ok().unwrap();
        assert!(
            sessions
                .join(&joined, Some("luis"), "link", None, None, false)
                .is_ok()
        );
        assert!(sessions.expire_after(0, 60).is_ok());
        assert!(sessions.enter(&unjoined).is_err());
        assert!(sessions.enter(&joined).is_ok());
    }

    #[test]
    fn a_holder_is_live_for_a_while_after_its_last_receive() {
        let mut sessions = Sessions::open(None).unwrap();
        let session = sessions.create(false).ok().unwrap();
        assert!(
            sessions
                .join(&session, Some("luis"), "link", None, None, false)
                .is_ok()
        );
        let live = |sessions: &Sessions| {
            sessions
                .holder(&session, "luis")
                .ok()
                .flatten()
                .unwrap()
                .live
        };
        assert!(live(&sessions));
        sessions
            .db
            .execute("UPDATE participants SET since = '2000-01-01T00:00:00Z'", [])
            .unwrap();
        assert!(!live(&sessions));
        assert!(sessions.holder(&session, "ben").ok().flatten().is_none());
    }

    #[test]
    fn a_session_nobody_received_in_expires() {
        let mut sessions = Sessions::open(None).unwrap();
        let session = sessions.create(false).ok().unwrap();
        assert!(
            sessions
                .join(&session, Some("luis"), "link", None, None, false)
                .is_ok()
        );
        assert!(sessions.expire_after(60, 60).is_ok());
        assert!(sessions.enter(&session).is_ok());
        assert!(sessions.expire_after(60, 0).is_ok());
        assert!(sessions.enter(&session).is_err());
    }

    #[test]
    fn a_waiting_receive_keeps_its_session() {
        let mut sessions = Sessions::open(None).unwrap();
        let session = sessions.create(false).ok().unwrap();
        assert!(
            sessions
                .join(&session, Some("luis"), "link", None, None, false)
                .is_ok()
        );
        let secret: String = sessions
            .db
            .query_row("SELECT secret FROM participants", [], |row| row.get(0))
            .unwrap();
        let receive = Receive {
            after: None,
            read: None,
            own: false,
            presence: false,
            only: vec![],
            skip: vec![],
        };
        let (ticket, _answered) = sessions.receive(&session, &secret, receive).ok().unwrap();
        assert!(sessions.expire_after(60, 0).is_ok());
        assert!(sessions.enter(&session).is_ok());
        assert!(sessions.abandon(&ticket).is_ok());
        assert!(sessions.expire_after(60, 0).is_ok());
        assert!(sessions.enter(&session).is_err());
    }

    #[test]
    fn a_database_from_before_opens() {
        let path = std::env::temp_dir().join(format!("agentwire-{}.db", secret()));
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, used INTEGER NOT NULL);
                 INSERT INTO sessions VALUES ('old', 0);",
            )
            .unwrap();
        let mut sessions = Sessions::open(Some(&path)).unwrap();
        assert!(sessions.expire_after(UNJOINED, UNRECEIVED).is_ok());
        assert!(sessions.enter("old").is_err());
        drop(sessions);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_long_answer_is_cut_and_the_next_receive_returns_the_rest() {
        let mut sessions = Sessions::open(None).unwrap();
        let session = sessions.create(false).ok().unwrap();
        let mut secrets = Vec::new();
        for name in ["luis", "ben"] {
            let joined = sessions
                .join(&session, Some(name), "link", None, None, false)
                .ok()
                .unwrap();
            secrets.push(joined.link.rsplit('/').next().unwrap().to_owned());
        }
        let text = "a".repeat(60 * 1024);
        for _ in 0..100 {
            let sent = sessions.send(&session, &secrets[1], "text/plain", None, text.as_bytes());
            assert!(sent.is_ok());
        }
        let mut entries = 0;
        let mut answers = 0;
        // Ben's join, and his 100 entries.
        while entries < 101 {
            let receive = Receive {
                after: None,
                read: None,
                own: false,
                presence: false,
                only: vec![],
                skip: vec![],
            };
            let (ticket, mut answered) = sessions
                .receive(&session, &secrets[0], receive)
                .ok()
                .unwrap();
            let Ok(Answer::Lines(lines, read)) = answered.try_recv() else {
                panic!("a receive with entries waiting answers at once");
            };
            assert!(lines.len() <= MAX_ANSWER + 64 * 1024 + 4096);
            let got = lines.lines().count() - 1;
            assert!(got > 0);
            entries += got;
            answers += 1;
            assert_eq!(read, Some(entries as i64 + 1));
            assert!(sessions.settle(&ticket, read).is_ok());
        }
        assert_eq!(entries, 101);
        assert!(answers > 1);
    }
}
