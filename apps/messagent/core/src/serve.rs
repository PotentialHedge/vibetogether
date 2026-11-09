//! The shared bot: one Telegram bot for everyone, run as a service of ours.
//! A person links their private chat with it to their Vibe Together account by an OTP they approve,
//! through which the bot acts as them: it carries the chat into a session of their account,
//! as the person, and their agents join it there.
//!
//! It fetches Telegram's updates by long polling, so nothing reaches it from outside.
//! Each linked person has a directory of their own, by their Telegram id,
//! with their link (`link.json`, holding the token) and their bridge's files.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::ErrorKind,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    Paths,
    bridge::{Agents, Bridge, Revoked, Room, Waker},
    config::write_private,
    messenger::Messenger,
    telegram::{Bot, Message, Refusal, User, UserChat, message_of},
};

/// The app's name at the account service, its `client_id`, which the OTP's page shows.
pub const CLIENT_ID: &str = "messagent";

/// The name of the session a linked chat gets.
const SESSION_NAME: &str = "Telegram";

/// The most linkings at once, each a thread asking the account service, so that no one floods it:
/// one person has at most one at a time.
const MAX_LINKING: usize = 50;

/// What the service runs with.
pub struct Settings {
    pub bot: Bot,
    pub accounts: Accounts,
    /// Where its files are: the offset, and each person's directory.
    pub state: PathBuf,
}

/// Vibe Together's account service, as an app that acts as its person.
#[derive(Clone)]
pub struct Accounts {
    agent: ureq::Agent,
    url: String,
    secret: String,
}

/// An OTP the service gave, for the person to approve.
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
    /// The person approved it: the token.
    Approved(String),
    /// Denied or expired, with the service's error.
    Ended(String),
}

impl Accounts {
    /// The service at `url`, with the app's secret.
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

    fn post(&self, path: &str, token: Option<&str>, body: Value) -> Result<(u16, Value)> {
        let mut request = self.agent.post(format!("{}{path}", self.url));
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let mut response = request
            .send_json(body)
            .map_err(|error| anyhow!("{path}: {error}"))?;
        let status = response.status().as_u16();
        let body = response.body_mut().read_json().unwrap_or(Value::Null);
        Ok((status, body))
    }

    /// Asks for an OTP to act as the person, saying what for.
    pub fn ask(&self, what_for: &str) -> Result<DeviceCode> {
        let (status, body) = self.post(
            "/api/auth/device/code",
            None,
            json!({
                "client_id": CLIENT_ID,
                "client_secret": self.secret,
                "scope": "person",
                "for": what_for,
            }),
        )?;
        if status != 200 {
            return Err(anyhow!(
                "the account service refused an OTP ({status}): {body}"
            ));
        }
        Ok(serde_json::from_value(body)?)
    }

    /// Whether the person approved the OTP of `device_code` yet.
    pub fn poll(&self, device_code: &str) -> Result<Approval> {
        let (status, body) = self.post(
            "/api/auth/device/token",
            None,
            json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": CLIENT_ID,
                "client_secret": self.secret,
            }),
        )?;
        if status == 200 {
            let token = body["access_token"]
                .as_str()
                .context("the account service gave no token")?;
            return Ok(Approval::Approved(token.into()));
        }
        Ok(match body["error"].as_str() {
            Some("authorization_pending" | "slow_down") => Approval::Pending,
            Some(error) => Approval::Ended(error.into()),
            None => return Err(anyhow!("the account service answered {status}: {body}")),
        })
    }

    /// The person's name, or `None` where the token no longer counts.
    pub fn login(&self, token: &str) -> Result<Option<String>> {
        let mut response = self
            .agent
            .get(format!("{}/api/me", self.url))
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(|error| anyhow!("/api/me: {error}"))?;
        match response.status().as_u16() {
            200 => {
                let me: Value = response.body_mut().read_json()?;
                Ok(Some(
                    me["name"].as_str().context("/api/me gave no name")?.into(),
                ))
            }
            401 => Ok(None),
            status => Err(anyhow!("/api/me answered {status}")),
        }
    }

    /// Creates a session of the person's, and returns its address.
    pub fn create_session(&self, token: &str, name: &str) -> Result<String> {
        let (status, body) = self.post("/api/sessions", Some(token), json!({ "name": name }))?;
        match status {
            201 | 200 => Ok(body["address"]
                .as_str()
                .context("the new session has no address yet")?
                .into()),
            401 => Err(anyhow!("the token no longer counts").context(Revoked)),
            status => Err(anyhow!("creating a session failed ({status}): {body}")),
        }
    }

    /// Revokes the token itself, as its person unlinks the chat.
    pub fn revoke(&self, token: &str) -> Result<()> {
        let mut response = self
            .agent
            .delete(format!("{}/api/apps/self", self.url))
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(|error| anyhow!("/api/apps/self: {error}"))?;
        match response.status().as_u16() {
            204 | 401 | 404 => Ok(()),
            status => Err(anyhow!(
                "revoking the token failed ({status}): {}",
                response.body_mut().read_to_string().unwrap_or_default()
            )),
        }
    }
}

/// A person's link of their chat to their account.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Link {
    /// Their name, such as `luis`.
    login: String,
    /// The token the bot acts as them with.
    token: String,
}

/// A linked chat while the service runs.
struct Linked {
    login: String,
    token: String,
    bridge: Arc<Bridge>,
    chat: UserChat,
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
    state: PathBuf,
    linked: Mutex<HashMap<i64, Linked>>,
    /// The people linking, by Telegram id: one linking each at a time.
    linking: Mutex<HashSet<i64>>,
}

/// Creates a directory readable by its owner only.
fn private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

impl Service {
    fn person_dir(&self, user: i64) -> PathBuf {
        self.state.join("people").join(user.to_string())
    }

    fn chat(&self, user: i64) -> UserChat {
        UserChat {
            bot: self.bot.clone(),
            user,
        }
    }

    /// Tells the person something of messagent's own.
    fn tell(&self, user: i64, text: &str) {
        if let Err(error) = self.bot.send_message(user, text) {
            eprintln!("messagent serve: can't tell {user}: {error:#}");
        }
    }

    /// Starts the bridge of a linked chat.
    fn start(self: &Arc<Self>, user: i64, link: Link) -> Result<Arc<Bridge>> {
        let dir = self.person_dir(user);
        private_dir(&dir)?;
        let accounts = self.accounts.clone();
        let token = link.token.clone();
        let chat = self.chat(user);
        let bridge = Arc::new(Bridge::new(
            Paths {
                config: dir.clone(),
                state: dir,
            },
            Room {
                name: link.login.clone(),
                agents: Agents::Any,
                token: Some(link.token.clone()),
            },
            Box::new(move || accounts.create_session(&token, SESSION_NAME)),
            Box::new(move || Ok(Box::new(chat.clone()) as Box<dyn Messenger>)),
        )?);
        let service = self.clone();
        bridge.spawn(Waker::spawn(String::new(), || {}), move |error| {
            eprintln!("messagent serve: the bridge of {user} ended: {error:#}");
            service.ended(user, &error);
        });
        self.linked.lock().expect("no holder panics").insert(
            user,
            Linked {
                login: link.login,
                token: link.token,
                bridge: bridge.clone(),
                chat: self.chat(user),
            },
        );
        Ok(bridge)
    }

    /// A bridge ended: where its token was revoked, the chat is unlinked.
    fn ended(&self, user: i64, error: &anyhow::Error) {
        if error.downcast_ref::<Revoked>().is_none() {
            return;
        }
        let token = match self.linked.lock().expect("no holder panics").get(&user) {
            Some(linked) => linked.token.clone(),
            None => return,
        };
        if let Ok(None) = self.accounts.login(&token) {
            self.unlink(user);
            self.tell(
                user,
                "This chat was unlinked from your Vibe Together account. Send /start to link it again.",
            );
        }
    }

    /// Unlinks a chat: its token is revoked, its bridge leaves, and its files go.
    fn unlink(&self, user: i64) {
        let Some(linked) = self.linked.lock().expect("no holder panics").remove(&user) else {
            return;
        };
        linked.bridge.stop();
        if let Err(error) = self.accounts.revoke(&linked.token) {
            eprintln!("messagent serve: can't revoke the token of {user}: {error:#}");
        }
        if let Err(error) = fs::remove_dir_all(self.person_dir(user)) {
            eprintln!("messagent serve: can't remove the files of {user}: {error:#}");
        }
    }

    /// Starts linking a chat, unless it is linking already.
    fn link(self: &Arc<Self>, from: &User) {
        let user = from.id;
        {
            let mut linking = self.linking.lock().expect("no holder panics");
            if linking.contains(&user) {
                return;
            }
            if linking.len() >= MAX_LINKING {
                drop(linking);
                self.tell(
                    user,
                    "Busy linking other chats: try again in a few minutes.",
                );
                return;
            }
            linking.insert(user);
        }
        let service = self.clone();
        let what_for = what_for(from);
        thread::spawn(move || {
            if let Err(error) = service.linking(user, &what_for) {
                eprintln!("messagent serve: linking {user} failed: {error:#}");
                service.tell(
                    user,
                    "Linking failed on our side. Send /start to try again.",
                );
            }
            service
                .linking
                .lock()
                .expect("no holder panics")
                .remove(&user);
        });
    }

    /// Links a chat: the person approves the OTP, and the bridge starts.
    fn linking(self: &Arc<Self>, user: i64, what_for: &str) -> Result<()> {
        let code = self.accounts.ask(what_for)?;
        self.tell(
            user,
            &format!(
                "To link this chat to your Vibe Together account, open\n{}\nand approve it there, signed in. \
                 Approve only if the page shows the code {} and your own Telegram account.\n\
                 Once linked, I act as you: what you write here goes to your agents as yours, \
                 and their answers come back here. Telegram itself can read chats with bots.",
                code.verification_uri_complete, code.user_code
            ),
        );
        let until = Instant::now() + Duration::from_secs(code.expires_in);
        let mut interval = Duration::from_secs(code.interval.max(1));
        let token = loop {
            thread::sleep(interval);
            if Instant::now() > until {
                self.tell(
                    user,
                    "The link expired before it was approved. Send /start to try again.",
                );
                return Ok(());
            }
            match self.accounts.poll(&code.device_code) {
                Ok(Approval::Pending) => {}
                Ok(Approval::Approved(token)) => break token,
                Ok(Approval::Ended(error)) => {
                    let text = match error.as_str() {
                        "access_denied" => "Linking was denied. Send /start to try again.",
                        _ => "The link expired before it was approved. Send /start to try again.",
                    };
                    self.tell(user, text);
                    return Ok(());
                }
                Err(error) => {
                    eprintln!("messagent serve: asking about {user}'s OTP failed: {error:#}");
                    interval = (interval * 2).min(Duration::from_secs(60));
                }
            }
        };
        let login = self
            .accounts
            .login(&token)?
            .context("the new token doesn't count")?;
        let link = Link { login, token };
        let dir = self.person_dir(user);
        private_dir(&dir)?;
        write_private(&dir.join("link.json"), &serde_json::to_vec(&link)?)?;
        // A chat already linked, such as to another account, is unlinked first.
        self.unlink_quietly(user);
        let login = link.login.clone();
        let bridge = self.start(user, link)?;
        bridge.ensure()?;
        bridge.notice(&format!(
            "This Telegram chat is now linked to {login}'s account."
        ))?;
        self.tell(
            user,
            &format!(
                "Linked to {login}. Your agents find this chat among your sessions, as \"{SESSION_NAME}\". \
                 /stop unlinks it."
            ),
        );
        Ok(())
    }

    /// Unlinks a chat about to be linked anew, keeping the new link's file.
    fn unlink_quietly(&self, user: i64) {
        if let Some(linked) = self.linked.lock().expect("no holder panics").remove(&user) {
            linked.bridge.stop();
            if let Err(error) = self.accounts.revoke(&linked.token) {
                eprintln!("messagent serve: can't revoke the token of {user}: {error:#}");
            }
        }
    }

    /// Takes in one message: only a private chat is a conversation so far.
    fn message(self: &Arc<Self>, message: &Message) {
        let Some(from) = &message.from else {
            return;
        };
        if message.chat.kind != "private" || message.chat.id != from.id {
            return;
        }
        let user = from.id;
        let text = message.text.as_deref().map(str::trim);
        let linked = self
            .linked
            .lock()
            .expect("no holder panics")
            .get(&user)
            .map(|linked| {
                (
                    linked.login.clone(),
                    linked.bridge.clone(),
                    linked.chat.clone(),
                )
            });
        let Some((login, bridge, chat)) = linked else {
            self.link(from);
            return;
        };
        match text {
            Some("/stop") => {
                self.unlink(user);
                self.tell(user, "Unlinked: this chat no longer reaches your agents. Send /start to link it again.");
            }
            Some(text) if text == "/start" || text.starts_with("/start ") => self.tell(
                user,
                &format!("This chat is linked to {login}'s account. /stop unlinks it."),
            ),
            _ => {
                let arrived = message_of(message);
                if let Err(error) = bridge.arrived(&chat, arrived) {
                    eprintln!("messagent serve: can't carry a message of {user}: {error:#}");
                    if error.downcast_ref::<Revoked>().is_some() {
                        self.ended(user, &error);
                    }
                }
            }
        }
    }
}

/// What the OTP's page shows the link is for: the Telegram id and username, which no one else can
/// take, and the name, which anyone can choose, last.
pub fn what_for(from: &User) -> String {
    let username = from
        .username
        .as_deref()
        .map_or("no username".to_string(), |name| format!("@{name}"));
    let name: String = from.first_name.chars().take(64).collect();
    format!("Telegram id {}, {username}, named {name}", from.id)
}

/// Runs the shared bot for good.
pub fn serve(settings: Settings) -> Result<()> {
    private_dir(&settings.state)?;
    private_dir(&settings.state.join("people"))?;
    let lock = File::create(settings.state.join("serve.lock"))?;
    if lock.try_lock().is_err() {
        eprintln!("messagent serve: another `messagent serve` runs; waiting until it ends");
        lock.lock()?;
    }
    let offset_file = settings.state.join("telegram.json");
    let mut offset: Offset = match fs::read_to_string(&offset_file) {
        Ok(text) => serde_json::from_str(&text)?,
        Err(error) if error.kind() == ErrorKind::NotFound => Offset::default(),
        Err(error) => return Err(error.into()),
    };
    let service = Arc::new(Service {
        bot: settings.bot,
        accounts: settings.accounts,
        state: settings.state,
        linked: Mutex::new(HashMap::new()),
        linking: Mutex::new(HashSet::new()),
    });
    for entry in fs::read_dir(service.state.join("people"))? {
        let entry = entry?;
        let Ok(user) = entry.file_name().to_string_lossy().parse::<i64>() else {
            continue;
        };
        let link = match fs::read_to_string(entry.path().join("link.json")) {
            Ok(text) => serde_json::from_str(&text)?,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        service.start(user, link)?;
    }
    let mut delay = Duration::from_secs(1);
    loop {
        // Saved before each fetch, which confirms the updates before the offset to Telegram.
        write_private(&offset_file, &serde_json::to_vec(&offset)?)?;
        let updates = match service
            .bot
            .get_updates_of(offset.offset, &["message", "my_chat_member"])
        {
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
                service.message(message);
            }
            // The person blocked the bot: the chat is unlinked.
            if let Some(member) = &update.my_chat_member
                && member.chat.kind == "private"
                && member.new_chat_member.status == "kicked"
            {
                service.unlink(member.from.id);
            }
        }
    }
}
