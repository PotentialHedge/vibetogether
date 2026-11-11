//! The Telegram bridge: one bot for everyone, run as a service of ours.
//! A Telegram chat, private or a group, is bridged into one Vibe Together session, and the bot
//! passes everything both ways, Luis's decisions (2026-11-10).
//!
//! Vibe Together knows nothing of Telegram, Luis's decision (2026-11-11): a person links their
//! Telegram account once, by an OTP that grants the bridge to speak as them, and the bot alone
//! keeps which Telegram user is which account (`linked.json`). Everything else is managed here, in
//! the bot, Luis's decision (2026-11-11): "the interface is the VT telegram bot". /start links, or
//! where linked offers the person's sessions as buttons, and the one pressed gets the chat as a
//! room; /stop ends a chat's bridge; /unlink revokes the grant.
//!
//! The bridge is no participant, Luis's decision (2026-11-11): it reads the session without
//! joining it, with the grant of whoever bridged the chat, and speaks only as the people it
//! carries: a linked person as themselves, by their own grant; everyone else as
//! `telegram/<name>`, unverified. What the bridge would say of its own, such as which chat the
//! session reaches, is the room's info at the account service, not an entry.
//!
//! It fetches Telegram's updates by long polling, so nothing reaches it from outside.
//! Each bridged chat has a directory of its own, by its id, with its bridge (`bridge.json`) and
//! its place in the session (`place.json`).

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs::{self, File},
    io::ErrorKind,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use ::agentwire::chat::Ping;
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    agentwire::{self, Entry, JOIN, LEAVE, Received, Relay},
    bridge::{Backoff, SPEECH, base, is_image, pings, pings_any, plain, refused},
    config::write_private,
    messenger::{Arrived, Image, Messages, Reactions},
    reactions::{self, Reaction},
    telegram::{Bot, CallbackQuery, Message, Refusal, Update, User, UserChat, message_of},
};

/// The bridge's name at the account service, its `client_id`, which the OTP's page shows.
pub const CLIENT_ID: &str = "messagent";
/// The messenger it bridges, under whose name the people who linked no account speak, as
/// `telegram/<name>`, as the account service knows it of the bridge.
pub const MESSENGER: &str = "telegram";
/// The most a name under the messenger's is numbered, where the one before is taken.
const NUMBERED: u32 = 50;
/// Where a person makes a session, when they have none.
const SITE: &str = "https://vibetogether.potentialhedge.com/account/";

/// What Telegram shows of the bot, set as the service starts.
const COMMANDS: &[(&str, &str)] = &[
    ("start", "Link your account, or bridge this chat"),
    ("stop", "End this chat's bridge"),
    ("unlink", "Unlink your Vibe Together account"),
];
const DESCRIPTION: &str = "Talk with the agents of your Vibe Together sessions from Telegram.\n\n\
/start links your account and bridges this chat into a session. In a group, add me and send /start.\n\n\
https://vibetogether.potentialhedge.com";
const SHORT_DESCRIPTION: &str = "Talk with agents from Telegram, through Vibe Together. https://vibetogether.potentialhedge.com";

/// The most linkings at once, each a thread asking the account service.
const MAX_LINKING: usize = 50;
/// The most chats bridged at once, so that no one fills the service.
const MAX_CHATS: usize = 1000;
/// The most sessions offered as buttons.
const MAX_CHOICES: usize = 40;
/// How long the bot stays in a group nobody bridged.
const UNBRIDGED: Duration = Duration::from_secs(10 * 60);
/// The longest a label from Telegram gets: a group's title or a person's name.
const LABEL: usize = 60;

/// What the service runs with.
pub struct Settings {
    pub bot: Bot,
    pub accounts: Accounts,
    /// Where its files are: the offset, the linked people, and each chat's directory.
    pub state: PathBuf,
}

/// Vibe Together's account service, as a bridge.
#[derive(Clone)]
pub struct Accounts {
    agent: ureq::Agent,
    url: String,
    secret: String,
}

/// An OTP the service gave, for a person to approve.
#[derive(Deserialize, Debug)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Where an OTP is.
#[derive(Debug, PartialEq)]
pub enum Approval {
    Pending,
    /// The person approved it: the bridge's grant to speak as them.
    Approved(String),
    /// Denied or expired, with the service's error.
    Ended(String),
}

/// A session, as the account service lists it.
#[derive(Deserialize, Debug, Clone)]
pub struct OwnSession {
    pub id: String,
    pub name: String,
    pub project: Named,
    pub group: Named,
    pub address: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Named {
    pub name: String,
}

/// A room the bridge mirrors onto a session, as the account service tells it.
#[derive(Deserialize, Debug, Clone)]
pub struct Room {
    pub id: String,
    pub session: OwnSession,
}

/// What the account service answered: 401 and 404 mean the grant or the thing is gone.
fn gone(status: u16) -> bool {
    matches!(status, 401 | 404)
}

impl Accounts {
    /// The service at `url`, with the bridge's secret.
    pub fn new(url: &str, secret: &str) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            agent,
            url: url.trim_end_matches('/').into(),
            secret: secret.into(),
        }
    }

    /// One request, with the grant where one is given, and its status and body.
    fn call(
        &self,
        method: &str,
        path: &str,
        grant: Option<&str>,
        body: Option<Value>,
    ) -> Result<(u16, Value)> {
        let url = format!("{}{path}", self.url);
        let auth = grant.map(|grant| format!("Bearer {grant}"));
        let result = match (method, body) {
            ("GET", _) => {
                let mut request = self.agent.get(&url);
                if let Some(auth) = &auth {
                    request = request.header("Authorization", auth);
                }
                request.call()
            }
            ("DELETE", _) => {
                let mut request = self.agent.delete(&url);
                if let Some(auth) = &auth {
                    request = request.header("Authorization", auth);
                }
                request.call()
            }
            (method, body) => {
                let mut request = if method == "PATCH" {
                    self.agent.patch(&url)
                } else {
                    self.agent.post(&url)
                };
                if let Some(auth) = &auth {
                    request = request.header("Authorization", auth);
                }
                request.send_json(body.unwrap_or(Value::Null))
            }
        };
        let mut response = result.map_err(|error| anyhow!("{path}: {error}"))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::String(text))))
    }

    /// Fails on any status but `ok` and the ones that mean gone, which are `None`.
    fn expect(&self, what: &str, (status, body): (u16, Value), ok: u16) -> Result<Option<Value>> {
        if status == ok {
            Ok(Some(body))
        } else if gone(status) {
            Ok(None)
        } else {
            Err(anyhow!("{what} failed ({status}): {body}"))
        }
    }

    /// Asks for an OTP that grants the bridge to speak as the person, saying who asks.
    pub fn ask(&self, who: &str) -> Result<DeviceCode> {
        let body = json!({
            "client_id": CLIENT_ID,
            "client_secret": self.secret,
            "scope": "bridge",
            "for": who,
        });
        let (status, body) = self.call("POST", "/api/auth/device/code", None, Some(body))?;
        if status != 200 {
            return Err(anyhow!(
                "the account service refused an OTP ({status}): {body}"
            ));
        }
        Ok(serde_json::from_value(body)?)
    }

    /// Whether the person approved the OTP of `device_code` yet.
    pub fn poll(&self, device_code: &str) -> Result<Approval> {
        let (status, body) = self.call(
            "POST",
            "/api/auth/device/token",
            None,
            Some(json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": CLIENT_ID,
                "client_secret": self.secret,
            })),
        )?;
        if status == 200 {
            let grant = body["access_token"]
                .as_str()
                .context("the account service gave no grant")?;
            return Ok(Approval::Approved(grant.into()));
        }
        Ok(match body["error"].as_str() {
            Some("authorization_pending" | "slow_down") => Approval::Pending,
            Some(error) => Approval::Ended(error.into()),
            None => return Err(anyhow!("the account service answered {status}: {body}")),
        })
    }

    /// The name of the account `grant` speaks as, or `None` where it was revoked.
    pub fn account(&self, grant: &str) -> Result<Option<String>> {
        let answer = self.call("GET", "/api/bridges/self", Some(grant), None)?;
        Ok(self
            .expect("asking about the grant", answer, 200)?
            .and_then(|body| body["account"].as_str().map(String::from)))
    }

    /// The sessions of the person's groups, or `None` where the grant was revoked.
    pub fn sessions(&self, grant: &str) -> Result<Option<Vec<OwnSession>>> {
        let answer = self.call("GET", "/api/bridges/self/sessions", Some(grant), None)?;
        self.expect("listing the sessions", answer, 200)?
            .map(|body| Ok(serde_json::from_value(body)?))
            .transpose()
    }

    /// Mirrors a room onto `session`, or `None` where the grant or the session is gone.
    pub fn add(&self, grant: &str, session: &str, about: &str) -> Result<Option<Room>> {
        let answer = self.call(
            "POST",
            "/api/bridges/self/rooms",
            Some(grant),
            Some(json!({ "session": session, "about": about })),
        )?;
        self.expect("bridging the chat", answer, 201)?
            .map(|body| Ok(serde_json::from_value(body)?))
            .transpose()
    }

    /// Whether the room still is.
    pub fn room(&self, grant: &str, room: &str) -> Result<bool> {
        let answer = self.call("GET", &format!("/api/bridges/self/rooms/{room}"), Some(grant), None)?;
        Ok(self.expect("asking about the room", answer, 200)?.is_some())
    }

    /// Says what the room is, which its session's info shows.
    pub fn describe(&self, grant: &str, room: &str, about: &str) -> Result<()> {
        let answer = self.call(
            "PATCH",
            &format!("/api/bridges/self/rooms/{room}"),
            Some(grant),
            Some(json!({ "about": about })),
        )?;
        self.expect("saying what the room is", answer, 204).map(drop)
    }

    /// Stops mirroring the room.
    pub fn remove(&self, grant: &str, room: &str) -> Result<()> {
        let answer = self.call("DELETE", &format!("/api/bridges/self/rooms/{room}"), Some(grant), None)?;
        self.expect("removing the room", answer, 204).map(drop)
    }

    /// Revokes the grant, with its rooms.
    pub fn revoke(&self, grant: &str) -> Result<()> {
        let answer = self.call("DELETE", "/api/bridges/self", Some(grant), None)?;
        self.expect("revoking the grant", answer, 204).map(drop)
    }
}

/// A Telegram user who linked their account: its name, and the bridge's grant to speak as it.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Linked {
    login: String,
    grant: String,
}

/// A chat's bridge, as kept on disk.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Link {
    /// The room at the account service.
    room: String,
    /// Who bridged it, by Telegram id, by whose grant the bot reads the session.
    by: i64,
    /// Their account's name.
    login: String,
    session: String,
    /// Its address on the relay.
    address: String,
    /// Whether the chat is a private one, one person's alone.
    private: bool,
    /// The chat's label: a group's title, or the person's name.
    title: String,
}

/// The chat's place in its session, as kept on disk.
#[derive(Serialize, Deserialize, Debug, Default)]
struct Place {
    /// The last entry handled.
    after: u64,
    /// The entries that came from this chat, each with its message in Telegram.
    messages: BTreeMap<u64, String>,
    /// Those of them no agent has read yet.
    unseen: BTreeSet<u64>,
    /// How many were in the group when the session was last told.
    members: Option<u64>,
}

/// The most entries of a chat whose message is kept, for reactions and 👀.
const KEPT: usize = 2000;

/// A bridged chat while the service runs.
struct Bridged {
    chat: i64,
    link: Link,
    dir: PathBuf,
    place: Mutex<Place>,
    stopped: AtomicBool,
    /// Held while a message of the chat goes into the session until its entry is kept, so that
    /// reading the session never takes it for someone else's and carries it back.
    carrying: Mutex<()>,
}

impl Bridged {
    fn save(&self, place: &Place) -> Result<()> {
        write_private(&self.dir.join("place.json"), &serde_json::to_vec(place)?)
    }

    fn update(&self, change: impl FnOnce(&mut Place)) -> Result<()> {
        let mut place = self.place.lock().expect("no holder panics");
        change(&mut place);
        self.save(&place)
    }

    /// Keeps that entry `n` came from this chat's message `message`.
    fn sent(&self, n: u64, message: &str) -> Result<()> {
        self.update(|place| {
            place.messages.insert(n, message.to_string());
            place.unseen.insert(n);
            while place.messages.len() > KEPT {
                place.messages.pop_first();
            }
        })
    }

    /// Whether `name` is an agent whose reading marks this chat's messages seen:
    /// a participant's agent, and no person a bridge carries.
    fn is_agent(name: &str) -> bool {
        name.contains('/') && !name.starts_with(&format!("{MESSENGER}/"))
    }
}

/// How far the updates are fetched.
#[derive(Serialize, Deserialize, Default)]
struct Offset {
    offset: i64,
}

/// What every thread of the service shares.
struct Service {
    bot: Bot,
    /// The bot's username, for the link to its private chat.
    username: String,
    accounts: Accounts,
    relay: Relay,
    state: PathBuf,
    chats: Mutex<HashMap<i64, Arc<Bridged>>>,
    /// The people linking: one OTP each at a time, by Telegram id.
    linking: Mutex<HashSet<i64>>,
    /// The groups the bot was added to and nobody bridged yet, since when.
    waiting: Mutex<HashMap<i64, Instant>>,
    /// The Telegram users who linked their account, by Telegram id: Vibe Together knows nothing
    /// of it, and decides at each request whether the grant still holds.
    linked: Mutex<BTreeMap<i64, Linked>>,
    /// The participants through which the people carried speak, by session address and who:
    /// a linked person's login, or `telegram:<id>` for anyone else. Shared by every chat bridged
    /// into that session, since a name joins a session once.
    people: Mutex<BTreeMap<String, String>>,
}

/// Creates a directory readable by its owner only.
fn private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn load<T: DeserializeOwned + Default>(file: &Path) -> Result<T> {
    match fs::read_to_string(file) {
        Ok(text) => Ok(serde_json::from_str(&text)
            .with_context(|| format!("can't read {}", file.display()))?),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.into()),
    }
}

/// One line of at most `most` characters, for a label anyone in Telegram sets.
pub fn label(text: &str, most: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut label: String = line.chars().take(most).collect();
    if line.chars().count() > most {
        label.push('…');
    }
    label
}

/// A Telegram user as others read them: their name and, where they have one, their username.
pub fn name_of(user: &User) -> String {
    let name = match &user.last_name {
        Some(last) => format!("{} {last}", user.first_name),
        None => user.first_name.clone(),
    };
    let name = label(&name, LABEL);
    match &user.username {
        Some(username) => format!("{name} (@{})", label(username, 40)),
        None => name,
    }
}

/// A Telegram user's name as a part of an agentwire name, such as `luis-wirth` for "Luis Wirth":
/// lower case letters and digits, joined by hyphens, `someone` where none is left.
pub fn slug(user: &User) -> String {
    let name = match &user.last_name {
        Some(last) => format!("{} {last}", user.first_name),
        None => user.first_name.clone(),
    };
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "someone".into()
    } else {
        slug.into()
    }
}

/// The command a message gives the bot, such as `start`, from `/start` or `/start@bot args`.
fn command(message: &Message) -> Option<&str> {
    let text = message.text.as_deref()?.trim();
    let word = text.strip_prefix('/')?.split_whitespace().next()?;
    Some(word.split('@').next().unwrap_or(word))
}

/// Where a forwarded message came from, as one line.
fn origin(forward: &Value) -> String {
    let name = match forward["type"].as_str() {
        Some("user") => forward["sender_user"]["first_name"].as_str(),
        Some("hidden_user") => forward["sender_user_name"].as_str(),
        Some("chat") => forward["sender_chat"]["title"].as_str(),
        Some("channel") => forward["chat"]["title"].as_str(),
        _ => None,
    };
    label(name.unwrap_or("someone"), LABEL)
}

impl Service {
    fn chat_dir(&self, chat: i64) -> PathBuf {
        self.state.join("chats").join(chat.to_string())
    }

    fn telegram(&self, chat: i64) -> UserChat {
        UserChat {
            bot: self.bot.clone(),
            user: chat,
        }
    }

    /// Tells a chat something of the bot's own.
    fn tell(&self, chat: i64, text: &str) {
        if let Err(error) = self.bot.send_message(chat, text) {
            eprintln!("messagent serve: can't tell {chat}: {error:#}");
        }
    }

    fn bridged(&self, chat: i64) -> Option<Arc<Bridged>> {
        self.chats
            .lock()
            .expect("no holder panics")
            .get(&chat)
            .cloned()
    }

    fn linked(&self, user: i64) -> Option<Linked> {
        self.linked
            .lock()
            .expect("no holder panics")
            .get(&user)
            .cloned()
    }

    /// The grant by which the bot reads a chat's session: its bridger's.
    fn grant(&self, bridged: &Bridged) -> Option<String> {
        self.linked(bridged.link.by).map(|linked| linked.grant)
    }

    fn save_linked(&self) -> Result<()> {
        let linked = self.linked.lock().expect("no holder panics");
        write_private(
            &self.state.join("linked.json"),
            &serde_json::to_vec(&*linked)?,
        )
    }

    fn save_people(&self) -> Result<()> {
        let people = self.people.lock().expect("no holder panics");
        write_private(
            &self.state.join("people.json"),
            &serde_json::to_vec(&*people)?,
        )
    }

    /// Forgets that `user` linked their account, where the grant is still `grant`: it was revoked
    /// in Vibe Together. The chats they bridged end.
    fn forget(&self, user: i64, grant: &str) {
        {
            let mut linked = self.linked.lock().expect("no holder panics");
            if linked.get(&user).is_none_or(|linked| linked.grant != grant) {
                return;
            }
            linked.remove(&user);
        }
        if let Err(error) = self.save_linked() {
            eprintln!("messagent serve: can't keep who linked: {error:#}");
        }
        let theirs: Vec<i64> = self
            .chats
            .lock()
            .expect("no holder panics")
            .values()
            .filter(|bridged| bridged.link.by == user)
            .map(|bridged| bridged.chat)
            .collect();
        for chat in theirs {
            self.end(chat, false);
            self.tell(chat, "This chat is no longer bridged: its link was revoked.");
        }
    }

    /// Starts carrying a bridged chat.
    fn start(self: &Arc<Self>, chat: i64, link: Link) -> Result<Arc<Bridged>> {
        let dir = self.chat_dir(chat);
        private_dir(&dir)?;
        let bridged = Arc::new(Bridged {
            chat,
            place: Mutex::new(load(&dir.join("place.json"))?),
            dir,
            link,
            stopped: AtomicBool::new(false),
            carrying: Mutex::new(()),
        });
        self.chats
            .lock()
            .expect("no holder panics")
            .insert(chat, bridged.clone());
        let service = self.clone();
        let listening = bridged.clone();
        thread::spawn(move || {
            if let Err(error) = service.listen(&listening) {
                eprintln!("messagent serve: the bridge of {chat} ended: {error:#}");
            }
        });
        Ok(bridged)
    }

    /// Ends a chat's bridge here: it stops, the people it carried leave the session where no other
    /// chat carries them there, and its files go.
    /// `remove` removes its room at the account service too, as /stop does.
    fn end(&self, chat: i64, remove: bool) {
        let (bridged, shared) = {
            let mut chats = self.chats.lock().expect("no holder panics");
            let Some(bridged) = chats.remove(&chat) else {
                return;
            };
            let shared = chats
                .values()
                .any(|other| other.link.address == bridged.link.address);
            (bridged, shared)
        };
        bridged.stopped.store(true, Ordering::Relaxed);
        if !shared {
            let prefix = format!("{} ", bridged.link.address);
            let carried: Vec<String> = {
                let mut people = self.people.lock().expect("no holder panics");
                let keys: Vec<String> = people
                    .keys()
                    .filter(|key| key.starts_with(&prefix))
                    .cloned()
                    .collect();
                keys.iter().filter_map(|key| people.remove(key)).collect()
            };
            for link in carried {
                if let Err(error) = self.relay.leave(&link) {
                    eprintln!("messagent serve: can't leave the session of {chat}: {error:#}");
                }
            }
            if let Err(error) = self.save_people() {
                eprintln!("messagent serve: can't keep who speaks where: {error:#}");
            }
        }
        if remove
            && let Some(grant) = self.grant(&bridged)
            && let Err(error) = self.accounts.remove(&grant, &bridged.link.room)
        {
            eprintln!("messagent serve: can't remove the room of {chat}: {error:#}");
        }
        if let Err(error) = fs::remove_dir_all(self.chat_dir(chat)) {
            eprintln!("messagent serve: can't remove the files of {chat}: {error:#}");
        }
    }

    /// Whether the room still is at the account service: where it no longer is, removed in
    /// Vibe Together, gone with its session or its member, or its link revoked, the chat is told
    /// and it ends.
    fn still(&self, bridged: &Bridged) -> bool {
        let Some(grant) = self.grant(bridged) else {
            self.end(bridged.chat, false);
            self.tell(bridged.chat, "This chat is no longer bridged: its link was revoked.");
            return false;
        };
        match self.accounts.room(&grant, &bridged.link.room) {
            Ok(true) => true,
            Ok(false) => {
                self.end(bridged.chat, false);
                self.tell(
                    bridged.chat,
                    "This chat is no longer bridged: it was removed in Vibe Together. /start bridges it again.",
                );
                false
            }
            Err(error) => {
                eprintln!(
                    "messagent serve: can't ask about {}: {error:#}",
                    bridged.chat
                );
                true
            }
        }
    }

    /// Sends with the link of someone the bridge carries, joining again once where it was let go.
    fn send(
        &self,
        link: &str,
        grant: &str,
        kind: &str,
        filename: Option<&str>,
        body: &[u8],
    ) -> Result<u64> {
        match self.relay.send(link, kind, filename, body) {
            Err(error) if agentwire::status(&error) == Some(403) => {
                self.relay.rejoin(link, Some(grant))?;
                self.relay.send(link, kind, filename, body)
            }
            sent => sent,
        }
    }

    /// The link through which a linked person speaks in the chat's session, by their own grant,
    /// or `None` where they may not, such as no member of the session's group.
    fn person(&self, bridged: &Bridged, linked: &Linked) -> Result<Option<String>> {
        let key = format!("{} {}", bridged.link.address, linked.login);
        if let Some(link) = self.people.lock().expect("no holder panics").get(&key) {
            return Ok(Some(link.clone()));
        }
        match self
            .relay
            .join(&bridged.link.address, &linked.login, Some(&linked.grant))
        {
            Ok(joined) => {
                self.people
                    .lock()
                    .expect("no holder panics")
                    .insert(key, joined.link.clone());
                self.save_people()?;
                Ok(Some(joined.link))
            }
            Err(error) if matches!(agentwire::status(&error), Some(401 | 403 | 409)) => {
                eprintln!(
                    "messagent serve: {} doesn't speak in {}: {error:#}",
                    linked.login, bridged.chat
                );
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// The link through which `from`, who linked no account, speaks in the chat's session:
    /// `telegram/<name>`, numbered where the name is taken, kept by their Telegram id.
    fn stranger(&self, bridged: &Bridged, from: &User, grant: &str) -> Result<String> {
        let key = format!("{} {MESSENGER}:{}", bridged.link.address, from.id);
        if let Some(link) = self.people.lock().expect("no holder panics").get(&key) {
            return Ok(link.clone());
        }
        let base = slug(from);
        for i in 1..=NUMBERED {
            let name = if i == 1 {
                format!("{MESSENGER}/{base}")
            } else {
                format!("{MESSENGER}/{base}-{i}")
            };
            match self.relay.join(&bridged.link.address, &name, Some(grant)) {
                Ok(joined) => {
                    self.people
                        .lock()
                        .expect("no holder panics")
                        .insert(key, joined.link.clone());
                    self.save_people()?;
                    return Ok(joined.link);
                }
                Err(error) if agentwire::status(&error) == Some(409) => {}
                Err(error) => return Err(error),
            }
        }
        Err(anyhow!(
            "every name for {base} is taken in {}",
            bridged.chat
        ))
    }

    /// Sends what `from` said into the chat's session: as themselves where they linked their
    /// account and may speak there, else as `telegram/<name>`, unverified.
    fn speak(
        &self,
        bridged: &Bridged,
        from: &User,
        kind: &str,
        filename: Option<&str>,
        body: &[u8],
    ) -> Result<u64> {
        if let Some(linked) = self.linked(from.id)
            && let Some(link) = self.person(bridged, &linked)?
        {
            match self.send(&link, &linked.grant, kind, filename, body) {
                Err(error) if matches!(agentwire::status(&error), Some(401 | 403 | 404)) => {
                    eprintln!(
                        "messagent serve: {} no longer speaks in {}: {error:#}",
                        linked.login, bridged.chat
                    );
                    let key = format!("{} {}", bridged.link.address, linked.login);
                    self.people.lock().expect("no holder panics").remove(&key);
                    self.save_people()?;
                }
                sent => return sent,
            }
        }
        let grant = self
            .grant(bridged)
            .context("whoever bridged the chat unlinked")?;
        let link = self.stranger(bridged, from, &grant)?;
        self.send(&link, &grant, kind, filename, body)
    }

    /// What the room is, as its session's info shows it: the chat, and in a group how many are in it.
    fn about(&self, chat: i64, private: bool, title: &str) -> (String, Option<u64>) {
        if private {
            return (format!("{title}'s private Telegram chat"), None);
        }
        let members = self
            .bot
            .member_count(chat)
            .map(|n| n.saturating_sub(1))
            .ok();
        let count = members.map_or(String::new(), |n| format!(" ({n} people)"));
        (format!("the Telegram group \"{title}\"{count}"), members)
    }

    /// Tells the session's info who reads it, where a group's count changed.
    fn audience(&self, bridged: &Bridged) -> Result<()> {
        let link = &bridged.link;
        if link.private {
            return Ok(());
        }
        let (about, members) = self.about(bridged.chat, false, &link.title);
        let told = bridged.place.lock().expect("no holder panics").members;
        if told.is_some() && told == members {
            return Ok(());
        }
        let grant = self.grant(bridged).context("whoever bridged the chat unlinked")?;
        self.accounts.describe(&grant, &link.room, &about)?;
        bridged.update(|place| place.members = members)
    }

    /// The chat's label: a group's title, or the person's name.
    fn title(chat: &crate::telegram::Chat, from: &User) -> String {
        if chat.kind == "private" {
            name_of(from)
        } else {
            label(chat.title.as_deref().unwrap_or("a group"), LABEL)
        }
    }

    /// /start: links the sender's account, in their private chat, or where they linked it
    /// offers their sessions to bridge the chat into.
    fn begin(self: &Arc<Self>, message: &Message, from: &User) {
        let chat = message.chat.id;
        let private = message.chat.kind == "private";
        if self.linked(from.id).is_some() {
            self.offer(chat, from);
        } else if private {
            self.link(chat, from);
        } else {
            self.tell(
                chat,
                &format!(
                    "{}: link your account first, at https://t.me/{}?start=link, then send /start here again.",
                    label(&from.first_name, LABEL),
                    self.username
                ),
            );
        }
    }

    /// Starts linking `from`'s account, by an OTP they approve, unless they are linking already.
    fn link(self: &Arc<Self>, chat: i64, from: &User) {
        {
            let mut linking = self.linking.lock().expect("no holder panics");
            if linking.contains(&from.id) {
                return;
            }
            if linking.len() >= MAX_LINKING {
                drop(linking);
                self.tell(chat, "Busy: try again in a few minutes.");
                return;
            }
            linking.insert(from.id);
        }
        let service = self.clone();
        let from = from.clone();
        thread::spawn(move || {
            if let Err(error) = service.linking(chat, &from) {
                eprintln!("messagent serve: linking {} failed: {error:#}", from.id);
                service.tell(chat, "Linking failed on our side. /start tries again.");
            }
            service
                .linking
                .lock()
                .expect("no holder panics")
                .remove(&from.id);
        });
    }

    /// Links `from`'s account: they approve the OTP signed in, and the bot keeps the grant.
    fn linking(self: &Arc<Self>, chat: i64, from: &User) -> Result<()> {
        let code = self.accounts.ask(&what_for(from))?;
        self.tell(
            chat,
            &format!(
                "Link your Vibe Together account: open {} and approve the code {}.",
                code.verification_uri_complete, code.user_code
            ),
        );
        let until = Instant::now() + Duration::from_secs(code.expires_in);
        let mut interval = Duration::from_secs(code.interval.max(1));
        let grant = loop {
            thread::sleep(interval);
            if Instant::now() > until {
                self.tell(chat, "The code expired. /start tries again.");
                return Ok(());
            }
            match self.accounts.poll(&code.device_code) {
                Ok(Approval::Pending) => {}
                Ok(Approval::Approved(grant)) => break grant,
                Ok(Approval::Ended(error)) => {
                    let text = match error.as_str() {
                        "access_denied" => "Denied. /start tries again.",
                        _ => "The code expired. /start tries again.",
                    };
                    self.tell(chat, text);
                    return Ok(());
                }
                Err(error) => {
                    eprintln!("messagent serve: asking about {}'s OTP failed: {error:#}", from.id);
                    interval = (interval * 2).min(Duration::from_secs(60));
                }
            }
        };
        let login = self
            .accounts
            .account(&grant)?
            .context("the new grant doesn't count")?;
        // A Telegram account links one account: one it linked before is let go there.
        let before = self
            .linked
            .lock()
            .expect("no holder panics")
            .insert(from.id, Linked { login: login.clone(), grant });
        self.save_linked()?;
        if let Some(before) = before
            && before.login != login
            && let Err(error) = self.accounts.revoke(&before.grant)
        {
            eprintln!("messagent serve: can't revoke {}'s grant: {error:#}", before.login);
        }
        self.tell(chat, &format!("Linked as {login}."));
        if self.bridged(chat).is_none() {
            self.offer(chat, from);
        }
        Ok(())
    }

    /// Offers the sender's sessions as buttons, to bridge the chat into the one pressed.
    fn offer(&self, chat: i64, from: &User) {
        let Some(linked) = self.linked(from.id) else {
            return;
        };
        let sessions = match self.accounts.sessions(&linked.grant) {
            Ok(Some(sessions)) => sessions,
            Ok(None) => {
                self.forget(from.id, &linked.grant);
                self.tell(chat, "Your link was revoked. /start links again.");
                return;
            }
            Err(error) => {
                eprintln!("messagent serve: can't list {}'s sessions: {error:#}", linked.login);
                self.tell(chat, "That failed on our side. /start tries again.");
                return;
            }
        };
        if sessions.is_empty() {
            self.tell(chat, &format!("You have no session yet: make one at {SITE}, then /start."));
            return;
        }
        let buttons: Vec<(String, String)> = sessions
            .iter()
            .take(MAX_CHOICES)
            .map(|session| {
                (
                    label(&format!("{} · {}", session.name, session.project.name), LABEL),
                    format!("b:{}", session.id),
                )
            })
            .collect();
        let text = match self.bridged(chat) {
            Some(bridged) => format!(
                "Bridged by {}. Move it to which session?",
                bridged.link.login
            ),
            None => "Bridge this chat into which session?".into(),
        };
        if let Err(error) = self.bot.send_buttons(chat, &text, &buttons) {
            eprintln!("messagent serve: can't offer {chat} its sessions: {error:#}");
        }
    }

    /// A button pressed: bridges the chat into the session it names, by the presser's grant.
    fn pressed(self: &Arc<Self>, query: &CallbackQuery) {
        let answer = |text: Option<&str>| {
            if let Err(error) = self.bot.answer_callback(&query.id, text) {
                eprintln!("messagent serve: can't answer a button: {error:#}");
            }
        };
        let (Some(message), Some(session)) = (
            &query.message,
            query.data.as_deref().and_then(|data| data.strip_prefix("b:")),
        ) else {
            return answer(None);
        };
        let from = &query.from;
        if from.is_bot {
            return answer(None);
        }
        let Some(linked) = self.linked(from.id) else {
            return answer(Some("Link your account first: /start in a private chat with me."));
        };
        let chat = message.chat.id;
        let private = message.chat.kind == "private";
        if !private && self.chats.lock().expect("no holder panics").len() >= MAX_CHATS {
            return answer(Some("Busy: try again in a few minutes."));
        }
        let title = Self::title(&message.chat, from);
        match self.bridge(chat, private, &title, from.id, &linked, session) {
            Ok(Some(text)) => {
                answer(None);
                if let Err(error) = self.bot.edit_text(chat, message.message_id, &text) {
                    eprintln!("messagent serve: can't update the offer in {chat}: {error:#}");
                    self.tell(chat, &text);
                }
            }
            Ok(None) => answer(Some("That session is gone, or not yours.")),
            Err(error) => {
                eprintln!("messagent serve: bridging {chat} failed: {error:#}");
                answer(Some("That failed on our side. Try again."));
            }
        }
    }

    /// Bridges a chat into a session, ending its bridge before; what to tell the chat, or `None`
    /// where the account service refused the session.
    fn bridge(
        self: &Arc<Self>,
        chat: i64,
        private: bool,
        title: &str,
        by: i64,
        linked: &Linked,
        session: &str,
    ) -> Result<Option<String>> {
        let (about, members) = self.about(chat, private, title);
        let Some(room) = self.accounts.add(&linked.grant, session, &about)? else {
            return Ok(None);
        };
        let link = Link {
            room: room.id,
            by,
            login: linked.login.clone(),
            session: room.session.id.clone(),
            address: room
                .session
                .address
                .clone()
                .context("the session has no address yet")?,
            private,
            title: title.to_string(),
        };
        // A chat bridged already, such as into another session, ends first.
        if self.bridged(chat).is_some() {
            self.end(chat, true);
        }
        let dir = self.chat_dir(chat);
        private_dir(&dir)?;
        write_private(&dir.join("bridge.json"), &serde_json::to_vec(&link)?)?;
        self.waiting.lock().expect("no holder panics").remove(&chat);
        let bridged = self.start(chat, link)?;
        bridged.update(|place| place.members = members)?;
        Ok(Some(format!(
            "Bridged into \"{}\" ({}). Everything said here reaches it, and back. /stop ends it.{}",
            label(&room.session.name, LABEL),
            label(&room.session.group.name, LABEL),
            if private {
                ""
            } else {
                " Linked people show as themselves, everyone else as telegram/<name>."
            }
        )))
    }

    /// /unlink: revokes the sender's grant, and the chats they bridged end.
    fn unlink(&self, chat: i64, from: &User) {
        let Some(linked) = self.linked(from.id) else {
            self.tell(chat, "You haven't linked an account.");
            return;
        };
        if let Err(error) = self.accounts.revoke(&linked.grant) {
            eprintln!("messagent serve: can't revoke {}'s grant: {error:#}", linked.login);
            self.tell(chat, "That failed on our side. Try again.");
            return;
        }
        self.forget(from.id, &linked.grant);
        self.tell(chat, &format!("Unlinked from {}.", linked.login));
    }

    /// Whether `from` may end a chat's bridge: in a private chat its person, in a group whoever
    /// bridged it or an admin of the group.
    fn may_stop(&self, bridged: &Bridged, from: &User) -> bool {
        bridged.link.private
            || bridged.link.by == from.id
            || self
                .bot
                .member_status(bridged.chat, from.id)
                .is_ok_and(|status| status == "creator" || status == "administrator")
    }

    /// Takes in one message, or an edit of one.
    fn message(self: &Arc<Self>, message: &Message, edited: bool) {
        let chat = message.chat.id;
        if message.chat.kind == "channel" {
            return;
        }
        if let Some(to) = message.migrate_to_chat_id {
            self.migrate(chat, to);
            return;
        }
        let bridged = self.bridged(chat);
        // Someone joined or left a group: the session learns how many read it.
        if message.new_chat_members.is_some() || message.left_chat_member.is_some() {
            if let Some(bridged) = bridged
                && let Err(error) = self.audience(&bridged)
            {
                eprintln!("messagent serve: can't tell {chat}'s session its audience: {error:#}");
            }
            return;
        }
        // The sender is a person alone: no bot, and no channel or anonymous admin.
        let Some(from) = &message.from else {
            return;
        };
        if from.is_bot || message.sender_chat.is_some() {
            return;
        }
        let private = message.chat.kind == "private";
        match command(message).filter(|_| !edited) {
            Some("unlink") if private => return self.unlink(chat, from),
            Some("start") => return self.begin(message, from),
            Some("stop") => {
                match &bridged {
                    Some(bridged) if self.may_stop(bridged, from) => {
                        self.end(chat, true);
                        self.tell(chat, "Bridge ended. /start bridges it again.");
                    }
                    Some(_) => self.tell(chat, "Only whoever bridged it, or a group admin, ends it."),
                    None => self.tell(chat, "This chat isn't bridged."),
                }
                return;
            }
            _ => {}
        }
        let Some(bridged) = bridged else {
            if edited {
                return;
            }
            if private {
                self.begin(message, from);
            } else if !self
                .waiting
                .lock()
                .expect("no holder panics")
                .contains_key(&chat)
            {
                // A group nobody bridged, such as from before a restart.
                if let Err(error) = self.bot.leave_chat(chat) {
                    eprintln!("messagent serve: can't leave {chat}: {error:#}");
                }
            }
            return;
        };
        if let Err(error) = self.carry(&bridged, message, from, edited) {
            eprintln!("messagent serve: can't carry a message of {chat}: {error:#}");
            if matches!(agentwire::status(&error), Some(401 | 403 | 404)) {
                self.still(&bridged);
            }
        }
    }

    /// Carries a message into the session: as its sender where they linked their account, else
    /// as `telegram/<name>`, unverified.
    fn carry(&self, bridged: &Bridged, message: &Message, from: &User, edited: bool) -> Result<()> {
        let Arrived::Message { id, image, text } = message_of(message) else {
            return Ok(());
        };
        // What it is: an edit, or a forward of someone else's words, which stay theirs.
        let mut marks = Vec::new();
        if edited {
            marks.push("edited".to_string());
        }
        if let Some(forward) = &message.forward_origin {
            marks.push(format!("forwarded from {}", origin(forward)));
        }
        let mark = if marks.is_empty() {
            String::new()
        } else {
            format!("[{}] ", marks.join(", "))
        };
        let text = text.filter(|text| !text.is_empty());
        let telegram = self.telegram(bridged.chat);
        let _carrying = bridged.carrying.lock().expect("no holder panics");
        if let Some(file) = &image {
            let bytes = telegram.download(file)?;
            let n = self.speak(bridged, from, &file.kind, file.filename.as_deref(), &bytes)?;
            bridged.sent(n, &id)?;
        }
        let said = match text {
            Some(text) => Some(format!("{mark}{text}")),
            None => (!mark.is_empty() && image.is_none()).then(|| mark.trim().to_string()),
        };
        if let Some(said) = said {
            let n = self.speak(bridged, from, SPEECH, None, said.as_bytes())?;
            bridged.sent(n, &id)?;
        }
        Ok(())
    }

    /// A group became a supergroup: its bridge moves to the new id.
    fn migrate(self: &Arc<Self>, from: i64, to: i64) {
        let Some(bridged) = self.chats.lock().expect("no holder panics").remove(&from) else {
            return;
        };
        bridged.stopped.store(true, Ordering::Relaxed);
        let moved = fs::rename(self.chat_dir(from), self.chat_dir(to))
            .map_err(anyhow::Error::from)
            .and_then(|()| self.start(to, bridged.link.clone()).map(drop));
        if let Err(error) = moved {
            eprintln!("messagent serve: can't move the bridge of {from} to {to}: {error:#}");
        }
    }

    /// The bot was added to a group, or removed from a chat.
    fn membership(&self, update: &crate::telegram::ChatMember) {
        let chat = update.chat.id;
        let status = update.new_chat_member.status.as_str();
        if matches!(status, "left" | "kicked") {
            self.waiting.lock().expect("no holder panics").remove(&chat);
            if self.bridged(chat).is_some() {
                self.end(chat, true);
            }
            return;
        }
        if update.chat.kind != "private" && self.bridged(chat).is_none() {
            self.waiting
                .lock()
                .expect("no holder panics")
                .insert(chat, Instant::now());
            self.tell(
                chat,
                "Send /start to bridge this group into a Vibe Together session. Without it I leave in 10 minutes.",
            );
        }
    }

    /// Leaves the groups nobody bridged in time.
    fn leave_unbridged(&self) {
        let due: Vec<i64> = {
            let mut waiting = self.waiting.lock().expect("no holder panics");
            let due: Vec<i64> = waiting
                .iter()
                .filter(|(_, since)| since.elapsed() > UNBRIDGED)
                .map(|(chat, _)| *chat)
                .collect();
            for chat in &due {
                waiting.remove(chat);
            }
            due
        };
        for chat in due {
            if self.bridged(chat).is_none()
                && let Err(error) = self.bot.leave_chat(chat)
            {
                eprintln!("messagent serve: can't leave {chat}: {error:#}");
            }
        }
    }

    /// Reads the session for good, without joining it, carrying what comes out to the chat.
    fn listen(&self, bridged: &Bridged) -> Result<()> {
        let telegram = self.telegram(bridged.chat);
        let mut backoff = Backoff::new();
        while !bridged.stopped.load(Ordering::Relaxed) {
            let after = bridged.place.lock().expect("no holder panics").after;
            let Some(grant) = self.grant(bridged) else {
                self.still(bridged);
                return Ok(());
            };
            match self.relay.read(&bridged.link.address, after, &grant) {
                Ok(received) => {
                    backoff = Backoff::new();
                    self.received(bridged, &telegram, received)?;
                }
                Err(error) => {
                    if matches!(agentwire::status(&error), Some(403 | 404)) && !self.still(bridged)
                    {
                        return Ok(());
                    }
                    backoff.wait(&error);
                }
            }
        }
        Ok(())
    }

    /// Takes in one read: what goes out to the chat, and what the agents have read.
    fn received(&self, bridged: &Bridged, telegram: &UserChat, received: Received) -> Result<()> {
        for entry in &received.entries {
            if bridged.stopped.load(Ordering::Relaxed) {
                return Ok(());
            }
            let (after, ours) = {
                let _carrying = bridged.carrying.lock().expect("no holder panics");
                let place = bridged.place.lock().expect("no holder panics");
                (place.after, place.messages.contains_key(&entry.n))
            };
            if entry.n <= after {
                continue;
            }
            // What came from this chat is the chat's already; one that pings the bridge alone, by
            // its messenger's name, `telegram`, is for its use, such as an image a Telegram message
            // sends. `<person>/messagent`, the per-person bridge's name, counts too, so that an
            // agent writing for that one sends nothing twice here.
            let for_bridge = !entry.is(telegram.native())
                && matches!(Ping::of(&entry.kind), Some(Ping::Only(names))
                    if !names.is_empty() && names.iter().all(|name| name == MESSENGER || name.ends_with(&format!("/{CLIENT_ID}"))));
            if !(ours || for_bridge || entry.is(JOIN) || entry.is(LEAVE)) {
                self.deliver(bridged, telegram, entry)?;
            }
            bridged.update(|place| place.after = entry.n)?;
        }
        let read = received
            .presence
            .iter()
            .filter(|(name, _)| Bridged::is_agent(name))
            .map(|(_, presence)| presence.read)
            .max()
            .unwrap_or(0);
        let seen: Vec<(u64, String)> = {
            let place = bridged.place.lock().expect("no holder panics");
            place
                .unseen
                .range(..=read)
                .filter_map(|n| place.messages.get(n).map(|message| (*n, message.clone())))
                .collect()
        };
        let mut reacted = HashSet::new();
        for (n, message) in seen {
            if reacted.insert(message.clone())
                && let Err(error) = telegram.react(&message, "👀")
            {
                eprintln!("messagent serve: can't mark a message seen: {error:#}");
            }
            bridged.update(|place| {
                place.unseen.remove(&n);
            })?;
        }
        bridged.update(|place| {
            place
                .unseen
                .retain(|n| *n > read || place.messages.contains_key(n))
        })?;
        Ok(())
    }

    /// Carries an entry out, riding out passing failures; one Telegram refuses is skipped.
    fn deliver(&self, bridged: &Bridged, telegram: &UserChat, entry: &Entry) -> Result<()> {
        let mut backoff = Backoff::new();
        loop {
            match self.out(bridged, telegram, entry) {
                Ok(()) => return Ok(()),
                Err(error) if refused(&error) => {
                    eprintln!(
                        "messagent serve: entry {} didn't reach {}: {error:#}",
                        entry.n, bridged.chat
                    );
                    return Ok(());
                }
                Err(error) => backoff.wait(&error),
            }
        }
    }

    /// Carries one entry out to the chat, if it is for people.
    fn out(&self, bridged: &Bridged, telegram: &UserChat, entry: &Entry) -> Result<()> {
        let grant = self
            .grant(bridged)
            .context("whoever bridged the chat unlinked")?;
        let fetch = |n: u64| self.relay.fetch_read(&bridged.link.address, n, &grant);
        if entry.is(reactions::REACTION) {
            let reaction: Reaction = serde_json::from_str(entry.text.as_deref().unwrap_or(""))?;
            let message = bridged
                .place
                .lock()
                .expect("no holder panics")
                .messages
                .get(&reaction.entry)
                .cloned();
            if let Some(message) = message {
                telegram.react(&message, &reaction.emoji)?;
                bridged.update(|place| {
                    place.unseen.remove(&reaction.entry);
                })?;
            }
            return Ok(());
        }
        let image = |n: u64| -> Result<Image> {
            let payload = fetch(n)?;
            Ok(Image {
                kind: base(&payload.kind),
                filename: payload.filename,
                bytes: payload.bytes,
            })
        };
        // What pings nobody in the chat reaches it without a notification: in a private chat
        // its person is pinged by their name, in a group anyone by a message for everyone.
        let quiet = if bridged.link.private {
            !pings(entry, &bridged.link.login, telegram.native())
        } else {
            !pings_any(entry, telegram.native(), |_| false)
        };
        if entry.is(telegram.native()) {
            let body = match &entry.text {
                Some(text) => text.clone().into_bytes(),
                None => fetch(entry.n)?.bytes,
            };
            telegram.send_native(&body, &image, quiet)?;
            return Ok(());
        }
        if !::agentwire::chat::is_message(&entry.kind) {
            return Ok(());
        }
        if is_image(entry) {
            telegram.send_image(&image(entry.n)?, quiet)?;
            return Ok(());
        }
        // In a private chat its person's own agents speak without a name, as a friend does.
        let by = format!("{}/", bridged.link.login);
        let text = plain(entry, |name| bridged.link.private && name.starts_with(&by));
        for part in telegram.split(&text) {
            telegram.send(&part, quiet)?;
        }
        Ok(())
    }
}

/// Who asks, as the OTP's page shows it: the Telegram id and username, which no one else can
/// take, and the name, which anyone can choose, last.
pub fn what_for(from: &User) -> String {
    let username = from
        .username
        .as_deref()
        .map_or("no username".to_string(), |name| {
            format!("@{}", label(name, 40))
        });
    format!(
        "Telegram id {}, {username}, named {}",
        from.id,
        label(&from.first_name, 64)
    )
}

/// Runs the bot for good.
pub fn serve(settings: Settings) -> Result<()> {
    private_dir(&settings.state)?;
    let lock = File::create(settings.state.join("serve.lock"))?;
    if lock.try_lock().is_err() {
        eprintln!("messagent serve: another `messagent serve` runs; waiting until it ends");
        lock.lock()?;
    }
    // The links of before bridges, each a person's chat with an app's grant, which no longer counts.
    let before = settings.state.join("people");
    if before.exists() {
        eprintln!(
            "messagent serve: removing the links of before bridges, whose grants no longer count"
        );
        fs::remove_dir_all(&before)?;
    }
    // The state of before grants, Luis's decision (2026-11-11): each chat's bridge held a
    // credential for one session, and the linked Telegram accounts were Vibe Together's too.
    // Neither counts any more, so each person links again, once.
    let identities = settings.state.join("identities.json");
    if identities.exists() {
        eprintln!("messagent serve: removing the bridges of before grants, which no longer count");
        for old in ["chats", "people.json"] {
            let path = settings.state.join(old);
            if path.is_dir() {
                fs::remove_dir_all(&path)?;
            } else if path.exists() {
                fs::remove_file(&path)?;
            }
        }
        fs::remove_file(&identities)?;
    }
    private_dir(&settings.state.join("chats"))?;
    let username = settings
        .bot
        .get_me()?
        .username
        .context("the bot has no username")?;
    let offset_file = settings.state.join("telegram.json");
    let mut offset: Offset = load(&offset_file)?;
    let service = Arc::new(Service {
        bot: settings.bot,
        username,
        accounts: settings.accounts,
        relay: Relay::new(),
        linked: Mutex::new(load(&settings.state.join("linked.json"))?),
        people: Mutex::new(load(&settings.state.join("people.json"))?),
        state: settings.state,
        chats: Mutex::new(HashMap::new()),
        linking: Mutex::new(HashSet::new()),
        waiting: Mutex::new(HashMap::new()),
    });
    for entry in fs::read_dir(service.state.join("chats"))? {
        let entry = entry?;
        let Ok(chat) = entry.file_name().to_string_lossy().parse::<i64>() else {
            continue;
        };
        let link: Option<Link> = match fs::read_to_string(entry.path().join("bridge.json")) {
            Ok(text) => Some(serde_json::from_str(&text)?),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        match link {
            Some(link) => {
                service.start(chat, link)?;
            }
            None => fs::remove_dir_all(entry.path())?,
        }
    }
    if let Err(error) = service
        .bot
        .introduce(COMMANDS, DESCRIPTION, SHORT_DESCRIPTION)
    {
        eprintln!("messagent serve: can't set what Telegram shows of the bot: {error:#}");
    }
    let mut delay = Duration::from_secs(1);
    loop {
        service.leave_unbridged();
        // Saved before each fetch, which confirms the updates before the offset to Telegram.
        write_private(&offset_file, &serde_json::to_vec(&offset)?)?;
        let updates: Vec<Update> = match service.bot.get_updates_of(
            offset.offset,
            &["message", "edited_message", "my_chat_member", "callback_query"],
        ) {
            Ok(updates) => {
                delay = Duration::from_secs(1);
                updates
            }
            Err(error) => {
                if error
                    .downcast_ref::<Refusal>()
                    .is_some_and(|refusal| refusal.code == 401)
                {
                    return Err(error).context("the bot's token is no longer valid");
                }
                eprintln!("messagent serve: {error:#}; trying again in {delay:?}");
                thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        for update in updates {
            if update.update_id < offset.offset {
                continue;
            }
            offset.offset = update.update_id + 1;
            if let Some(message) = &update.message {
                service.message(message, false);
            }
            if let Some(message) = &update.edited_message {
                service.message(message, true);
            }
            if let Some(member) = &update.my_chat_member {
                service.membership(member);
            }
            if let Some(query) = &update.callback_query {
                service.pressed(query);
            }
        }
    }
}
