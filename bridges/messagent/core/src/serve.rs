//! The Telegram bridge: one bot for everyone, run as a service of ours.
//! A Telegram chat, private or a group, is bridged into one Vibe Together session that a member
//! picks as they approve the bot's OTP, and the bot passes everything both ways, Luis's decisions
//! (2026-11-10).
//!
//! The bridge is no participant, Luis's decision (2026-11-11): it reads the session without
//! joining it, and speaks only as the people it carries. A person who linked their Telegram
//! account, by an OTP from their private chat with the bot, speaks as themselves; everyone else
//! as `telegram/<name>`, unverified. What the bridge would say of its own, such as which chat the
//! session reaches, is the session's info at the account service, not an entry.
//!
//! It fetches Telegram's updates by long polling, so nothing reaches it from outside.
//! Each bridged chat has a directory of its own, by its id, with its bridge (`bridge.json`,
//! holding the credential) and its place in the session (`place.json`).

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
    telegram::{Bot, Message, Refusal, Update, User, UserChat, message_of},
};

/// The bridge's name at the account service, its `client_id`, which the OTP's page shows.
pub const CLIENT_ID: &str = "messagent";
/// The messenger it bridges, under whose name the people who linked no account speak, as
/// `telegram/<name>`, as the account service knows it of the bridge.
pub const MESSENGER: &str = "telegram";
/// The most a name under the messenger's is numbered, where the one before is taken.
const NUMBERED: u32 = 50;

/// What Telegram shows of the bot, set as the service starts.
const COMMANDS: &[(&str, &str)] = &[
    ("start", "Bridge this chat into a Vibe Together session"),
    ("stop", "End this chat's bridge"),
];
const DESCRIPTION: &str = "This bot bridges a Telegram chat, private or a group, into a Vibe Together session: \
everything said in either reaches the other, so you talk with the agents there from here.\n\n\
Send /start, then approve on the page it sends you, signed in, and pick the session. /stop ends the bridge.\n\n\
https://vibetogether.potentialhedge.com";
const SHORT_DESCRIPTION: &str = "Talk with agents from Telegram, through Vibe Together. https://vibetogether.potentialhedge.com";

/// The most bridgings at once, each a thread asking the account service, one per chat.
const MAX_LINKING: usize = 50;
/// The most chats bridged at once, so that no one fills the service.
const MAX_CHATS: usize = 1000;
/// How long the bot stays in a group nobody bridged.
const UNBRIDGED: Duration = Duration::from_secs(10 * 60);
/// The longest a label from Telegram gets: a group's title or a person's name.
const LABEL: usize = 60;

/// What the service runs with.
pub struct Settings {
    pub bot: Bot,
    pub accounts: Accounts,
    /// Where its files are: the offset, the linked identities, and each chat's directory.
    pub state: PathBuf,
}

/// Vibe Together's account service, as a bridge.
#[derive(Clone)]
pub struct Accounts {
    agent: ureq::Agent,
    url: String,
    secret: String,
}

/// An OTP the service gave, for a member to approve.
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
    /// A member approved it: the bridge's credential.
    Approved(String),
    /// Denied or expired, with the service's error.
    Ended(String),
}

/// A bridge, as the account service tells it of itself.
#[derive(Deserialize, Debug, Clone)]
pub struct Own {
    /// Who added it.
    pub by: String,
    pub session: OwnSession,
}

#[derive(Deserialize, Debug, Clone)]
pub struct OwnSession {
    pub id: String,
    pub name: String,
    pub group: Named,
    pub address: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Named {
    pub name: String,
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

    fn post(&self, path: &str, body: Value) -> Result<(u16, Value)> {
        let mut response = self
            .agent
            .post(format!("{}{path}", self.url))
            .send_json(body)
            .map_err(|error| anyhow!("{path}: {error}"))?;
        let status = response.status().as_u16();
        let body = response.body_mut().read_json().unwrap_or(Value::Null);
        Ok((status, body))
    }

    /// Asks for an OTP to be added to a session, saying what it bridges, and where the chat is
    /// the sender's alone, their Telegram id and name, which approving links.
    pub fn ask(&self, what_for: &str, identity: Option<(i64, String)>) -> Result<DeviceCode> {
        let mut body = json!({
            "client_id": CLIENT_ID,
            "client_secret": self.secret,
            "scope": "bridge",
            "for": what_for,
        });
        if let Some((id, name)) = identity {
            body["identity"] = id.to_string().into();
            body["identity_name"] = name.into();
        }
        let (status, body) = self.post("/api/auth/device/code", body)?;
        if status != 200 {
            return Err(anyhow!(
                "the account service refused an OTP ({status}): {body}"
            ));
        }
        Ok(serde_json::from_value(body)?)
    }

    /// Whether a member approved the OTP of `device_code` yet.
    pub fn poll(&self, device_code: &str) -> Result<Approval> {
        let (status, body) = self.post(
            "/api/auth/device/token",
            json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": CLIENT_ID,
                "client_secret": self.secret,
            }),
        )?;
        if status == 200 {
            let credential = body["access_token"]
                .as_str()
                .context("the account service gave no credential")?;
            return Ok(Approval::Approved(credential.into()));
        }
        Ok(match body["error"].as_str() {
            Some("authorization_pending" | "slow_down") => Approval::Pending,
            Some(error) => Approval::Ended(error.into()),
            None => return Err(anyhow!("the account service answered {status}: {body}")),
        })
    }

    /// The bridge of `credential`, or `None` where it no longer is.
    pub fn own(&self, credential: &str) -> Result<Option<Own>> {
        let mut response = self
            .agent
            .get(format!("{}/api/bridges/self", self.url))
            .header("Authorization", format!("Bearer {credential}"))
            .call()
            .map_err(|error| anyhow!("/api/bridges/self: {error}"))?;
        match response.status().as_u16() {
            200 => Ok(Some(response.body_mut().read_json()?)),
            401 | 404 => Ok(None),
            status => Err(anyhow!("/api/bridges/self answered {status}")),
        }
    }

    /// Says what the bridge's room is, which its session's info shows.
    pub fn describe(&self, credential: &str, about: &str) -> Result<()> {
        let mut response = self
            .agent
            .patch(format!("{}/api/bridges/self", self.url))
            .header("Authorization", format!("Bearer {credential}"))
            .send_json(json!({ "about": about }))
            .map_err(|error| anyhow!("/api/bridges/self: {error}"))?;
        match response.status().as_u16() {
            204 => Ok(()),
            status => Err(anyhow!(
                "saying what the bridge's room is failed ({status}): {}",
                response.body_mut().read_to_string().unwrap_or_default()
            )),
        }
    }

    /// Removes the bridge of `credential` from its session.
    pub fn remove(&self, credential: &str) -> Result<()> {
        let mut response = self
            .agent
            .delete(format!("{}/api/bridges/self", self.url))
            .header("Authorization", format!("Bearer {credential}"))
            .call()
            .map_err(|error| anyhow!("/api/bridges/self: {error}"))?;
        match response.status().as_u16() {
            204 | 401 | 404 => Ok(()),
            status => Err(anyhow!(
                "removing the bridge failed ({status}): {}",
                response.body_mut().read_to_string().unwrap_or_default()
            )),
        }
    }
}

/// A chat's bridge, as kept on disk.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Link {
    /// The credential the bot reads the session with, and joins it as the people it carries.
    credential: String,
    /// Who added it.
    by: String,
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
    accounts: Accounts,
    relay: Relay,
    state: PathBuf,
    chats: Mutex<HashMap<i64, Arc<Bridged>>>,
    /// The chats being bridged: one bridging each at a time.
    linking: Mutex<HashSet<i64>>,
    /// The groups the bot was added to and nobody bridged yet, since when.
    waiting: Mutex<HashMap<i64, Instant>>,
    /// The Telegram accounts linked to an account, by Telegram id, as the bot saw them linked;
    /// the account service decides whether they still are, at each join.
    identities: Mutex<BTreeMap<i64, String>>,
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

    fn save_identities(&self) -> Result<()> {
        let identities = self.identities.lock().expect("no holder panics");
        write_private(
            &self.state.join("identities.json"),
            &serde_json::to_vec(&*identities)?,
        )
    }

    fn save_people(&self) -> Result<()> {
        let people = self.people.lock().expect("no holder panics");
        write_private(
            &self.state.join("people.json"),
            &serde_json::to_vec(&*people)?,
        )
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
    /// `remove` removes it at the account service too, as /stop does.
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
        if remove && let Err(error) = self.accounts.remove(&bridged.link.credential) {
            eprintln!("messagent serve: can't remove the bridge of {chat}: {error:#}");
        }
        if let Err(error) = fs::remove_dir_all(self.chat_dir(chat)) {
            eprintln!("messagent serve: can't remove the files of {chat}: {error:#}");
        }
    }

    /// Whether the bridge still is at the account service: where it no longer is, removed in
    /// Vibe Together or gone with its session or its member, the chat is told and it ends.
    fn still(&self, bridged: &Bridged) -> bool {
        match self.accounts.own(&bridged.link.credential) {
            Ok(Some(_)) => true,
            Ok(None) => {
                self.end(bridged.chat, false);
                self.tell(
                    bridged.chat,
                    "This chat is no longer bridged: the bridge was removed in Vibe Together, or its session is gone. Send /start to bridge it again.",
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
        bridged: &Bridged,
        link: &str,
        kind: &str,
        filename: Option<&str>,
        body: &[u8],
    ) -> Result<u64> {
        match self.relay.send(link, kind, filename, body) {
            Err(error) if agentwire::status(&error) == Some(403) => {
                self.relay.rejoin(link, Some(&bridged.link.credential))?;
                self.relay.send(link, kind, filename, body)
            }
            sent => sent,
        }
    }

    /// The link through which `login` speaks in the chat's session, or `None` where they may not:
    /// they unlinked their Telegram, or are no member of the session's group.
    fn person(&self, bridged: &Bridged, login: &str) -> Result<Option<String>> {
        let key = format!("{} {login}", bridged.link.address);
        if let Some(link) = self.people.lock().expect("no holder panics").get(&key) {
            return Ok(Some(link.clone()));
        }
        match self
            .relay
            .join(&bridged.link.address, login, Some(&bridged.link.credential))
        {
            Ok(joined) => {
                self.people
                    .lock()
                    .expect("no holder panics")
                    .insert(key, joined.link.clone());
                self.save_people()?;
                Ok(Some(joined.link))
            }
            Err(error) if matches!(agentwire::status(&error), Some(403 | 409)) => {
                eprintln!(
                    "messagent serve: {login} doesn't speak in {}: {error:#}",
                    bridged.chat
                );
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// The link through which `from`, who linked no account, speaks in the chat's session:
    /// `telegram/<name>`, numbered where the name is taken, kept by their Telegram id.
    fn stranger(&self, bridged: &Bridged, from: &User) -> Result<String> {
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
            match self
                .relay
                .join(&bridged.link.address, &name, Some(&bridged.link.credential))
            {
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
    /// Telegram account and may speak there, else as `telegram/<name>`, unverified.
    fn speak(
        &self,
        bridged: &Bridged,
        from: &User,
        kind: &str,
        filename: Option<&str>,
        body: &[u8],
    ) -> Result<u64> {
        let login = self
            .identities
            .lock()
            .expect("no holder panics")
            .get(&from.id)
            .cloned();
        if let Some(login) = login
            && let Some(link) = self.person(bridged, &login)?
        {
            match self.send(bridged, &link, kind, filename, body) {
                Err(error) if matches!(agentwire::status(&error), Some(403 | 404)) => {
                    eprintln!(
                        "messagent serve: {login} no longer speaks in {}: {error:#}",
                        bridged.chat
                    );
                    let key = format!("{} {login}", bridged.link.address);
                    self.people.lock().expect("no holder panics").remove(&key);
                    self.save_people()?;
                }
                sent => return sent,
            }
        }
        let link = self.stranger(bridged, from)?;
        self.send(bridged, &link, kind, filename, body)
    }

    /// Tells the session's info who reads it: the chat, and in a group how many are in it.
    fn audience(&self, bridged: &Bridged) -> Result<()> {
        let link = &bridged.link;
        let about = if link.private {
            format!("{}'s private Telegram chat", link.title)
        } else {
            let members = self
                .bot
                .member_count(bridged.chat)
                .map(|n| n.saturating_sub(1))
                .ok();
            let told = bridged.place.lock().expect("no holder panics").members;
            if told.is_some() && told == members {
                return Ok(());
            }
            let count = members.map_or(String::new(), |n| format!(" ({n} people)"));
            self.accounts.describe(
                &link.credential,
                &format!("the Telegram group \"{}\"{count}", link.title),
            )?;
            return bridged.update(|place| place.members = members);
        };
        self.accounts.describe(&link.credential, &about)
    }

    /// Starts bridging a chat, unless it is being bridged already.
    fn link(self: &Arc<Self>, message: &Message, from: &User) {
        let chat = message.chat.id;
        {
            let mut linking = self.linking.lock().expect("no holder panics");
            if linking.contains(&chat) {
                return;
            }
            if linking.len() >= MAX_LINKING
                || self.chats.lock().expect("no holder panics").len() >= MAX_CHATS
            {
                drop(linking);
                self.tell(chat, "Busy: try again in a few minutes.");
                return;
            }
            linking.insert(chat);
        }
        let service = self.clone();
        let private = message.chat.kind == "private";
        let title = if private {
            name_of(from)
        } else {
            label(message.chat.title.as_deref().unwrap_or("a group"), LABEL)
        };
        let from = from.clone();
        thread::spawn(move || {
            if let Err(error) = service.linking(chat, private, &title, &from) {
                eprintln!("messagent serve: bridging {chat} failed: {error:#}");
                service.tell(
                    chat,
                    "Bridging failed on our side. Send /start to try again.",
                );
            }
            service
                .linking
                .lock()
                .expect("no holder panics")
                .remove(&chat);
        });
    }

    /// Bridges a chat: a member approves the OTP and picks the session, and the bridge starts.
    fn linking(self: &Arc<Self>, chat: i64, private: bool, title: &str, from: &User) -> Result<()> {
        let asker = what_for(from);
        let (what_for, identity) = if private {
            (
                format!("Telegram private chat with {asker}"),
                Some((from.id, name_of(from))),
            )
        } else {
            let members = self.bot.member_count(chat).map_or(String::new(), |n| {
                format!(", {} people", n.saturating_sub(1))
            });
            (
                format!("Telegram group \"{title}\", id {chat}{members}; asked by {asker}"),
                None,
            )
        };
        let code = self.accounts.ask(&what_for, identity)?;
        let linked = if private {
            " Approving also links your Telegram account to your Vibe Together account, so that what you write in bridged chats reaches their sessions as you."
        } else {
            ""
        };
        self.tell(
            chat,
            &format!(
                "To bridge this chat into a Vibe Together session, open\n{}\nsigned in, pick the session, and approve. \
                 Approve only if the page shows the code {}.{linked}\n\
                 Once bridged, everything said here reaches the session, its people and their agents, and everything said there comes here. \
                 Telegram itself can read chats with bots.",
                code.verification_uri_complete, code.user_code
            ),
        );
        let until = Instant::now() + Duration::from_secs(code.expires_in);
        let mut interval = Duration::from_secs(code.interval.max(1));
        let credential = loop {
            thread::sleep(interval);
            if Instant::now() > until {
                self.tell(
                    chat,
                    "The OTP expired before it was approved. Send /start to try again.",
                );
                return Ok(());
            }
            match self.accounts.poll(&code.device_code) {
                Ok(Approval::Pending) => {}
                Ok(Approval::Approved(credential)) => break credential,
                Ok(Approval::Ended(error)) => {
                    let text = match error.as_str() {
                        "access_denied" => "Bridging was denied. Send /start to try again.",
                        _ => "The OTP expired before it was approved. Send /start to try again.",
                    };
                    self.tell(chat, text);
                    return Ok(());
                }
                Err(error) => {
                    eprintln!("messagent serve: asking about {chat}'s OTP failed: {error:#}");
                    interval = (interval * 2).min(Duration::from_secs(60));
                }
            }
        };
        let own = self
            .accounts
            .own(&credential)?
            .context("the new bridge doesn't count")?;
        let link = Link {
            credential,
            by: own.by.clone(),
            session: own.session.id.clone(),
            address: own
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
        if private {
            self.identities
                .lock()
                .expect("no holder panics")
                .insert(from.id, own.by.clone());
            self.save_identities()?;
        }
        self.waiting.lock().expect("no holder panics").remove(&chat);
        let bridged = self.start(chat, link)?;
        self.audience(&bridged)?;
        self.tell(
            chat,
            &format!(
                "Bridged into the session \"{}\" of {}, added by {}. Everything said there comes here, and what is said here goes there.{} /stop ends the bridge.",
                label(&own.session.name, LABEL),
                label(&own.session.group.name, LABEL),
                own.by,
                if private {
                    ""
                } else {
                    " People who linked their Telegram account, in a private chat with me, show there as themselves; everyone else as telegram/<name>, unverified."
                }
            ),
        );
        Ok(())
    }

    /// Whether `from` may end a chat's bridge: in a private chat its person, in a group whoever
    /// added it, by their linked Telegram account, or an admin of the group.
    fn may_stop(&self, bridged: &Bridged, from: &User) -> bool {
        if bridged.link.private {
            return true;
        }
        let linked = self
            .identities
            .lock()
            .expect("no holder panics")
            .get(&from.id)
            .cloned();
        linked.as_deref() == Some(bridged.link.by.as_str())
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
        let Some(bridged) = bridged else {
            let private = message.chat.kind == "private";
            if edited {
                return;
            }
            if private || command(message) == Some("start") {
                self.link(message, from);
            } else if !self
                .waiting
                .lock()
                .expect("no holder panics")
                .contains_key(&chat)
                && !self
                    .linking
                    .lock()
                    .expect("no holder panics")
                    .contains(&chat)
            {
                // A group nobody bridged, such as from before a restart.
                if let Err(error) = self.bot.leave_chat(chat) {
                    eprintln!("messagent serve: can't leave {chat}: {error:#}");
                }
            }
            return;
        };
        match command(message).filter(|_| !edited) {
            Some("stop") => {
                if self.may_stop(&bridged, from) {
                    self.end(chat, true);
                    self.tell(chat, "The bridge ended: this chat no longer reaches the session. Send /start to bridge it again.");
                } else {
                    self.tell(
                        chat,
                        "Only whoever added the bridge, or an admin of the group, ends it.",
                    );
                }
            }
            Some("start") => self.tell(
                chat,
                &format!(
                    "This chat is bridged into a session, added by {}. /stop ends the bridge.",
                    bridged.link.by
                ),
            ),
            _ => {
                if let Err(error) = self.carry(&bridged, message, from, edited) {
                    eprintln!("messagent serve: can't carry a message of {chat}: {error:#}");
                    if matches!(agentwire::status(&error), Some(403 | 404)) {
                        self.still(&bridged);
                    }
                }
            }
        }
    }

    /// Carries a message into the session: as its sender where they linked their Telegram
    /// account, else as `telegram/<name>`, unverified.
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
            let linking = self.linking.lock().expect("no holder panics");
            let due: Vec<i64> = waiting
                .iter()
                .filter(|(chat, since)| since.elapsed() > UNBRIDGED && !linking.contains(chat))
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
            match self
                .relay
                .read(&bridged.link.address, after, &bridged.link.credential)
            {
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
        let fetch = |n: u64| {
            self.relay
                .fetch_read(&bridged.link.address, n, &bridged.link.credential)
        };
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
            !pings(entry, &bridged.link.by, telegram.native())
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
        let by = format!("{}/", bridged.link.by);
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
    private_dir(&settings.state.join("chats"))?;
    let offset_file = settings.state.join("telegram.json");
    let mut offset: Offset = load(&offset_file)?;
    let service = Arc::new(Service {
        bot: settings.bot,
        accounts: settings.accounts,
        relay: Relay::new(),
        identities: Mutex::new(load(&settings.state.join("identities.json"))?),
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
            &["message", "edited_message", "my_chat_member"],
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
        }
    }
}
