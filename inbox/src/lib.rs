//! An agent's inbox, Vibe Together's delivery on the agent's machine: a directory like a maildir,
//! which anything local may deliver into too:
//! `new/` holds the items not yet taken in, `cur/` the taken ones, `tmp/` the ones being written,
//! the file `wake` is the doorbell, and a lock on the file `awake` says the agent is in a turn.
//!
//! An item is one file, named `<time>.<sender>.<ext>`, such as `20261115T153012.123456Z.luis.md`,
//! with the time in UTC to the microsecond, so that the names sort by time, and the sender
//! encoded one to one: a `/` as `_`, and every other byte but ASCII letters, digits and `-` as
//! `%XX`, such as `luis_lead` for `luis/lead`.
//!
//! What it creates is its owner's alone: its directories 0700, its items and files 0600.

use std::{
  ffi::OsString,
  fs, io,
  io::{Read, Write},
  os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
  path::{Path, PathBuf},
  sync::{
    atomic::{AtomicU64, Ordering},
    mpsc,
  },
};

use jiff::{Timestamp, civil::DateTime, tz::TimeZone};
use notify::{RecursiveMode, Watcher};

const TIME_FORMAT: &str = "%Y%m%dT%H%M%S.%6fZ";
const TIME_LEN: usize = "20261115T153012.123456Z".len();

pub struct Inbox {
  pub root: PathBuf,
}

pub struct Item {
  /// Where the item lies now, in `cur/`.
  pub path: PathBuf,
  pub time: Timestamp,
  /// `None` for a file whose name is not in the item format, such as one copied in by hand.
  pub sender: Option<String>,
  pub content: Content,
}

pub enum Content {
  Text(String),
  /// Content that is not UTF-8, left in the file.
  File {
    mime: String,
  },
}

impl Inbox {
  pub fn new(root: impl Into<PathBuf>) -> Self {
    Self { root: root.into() }
  }

  pub fn new_dir(&self) -> PathBuf {
    self.root.join("new")
  }
  pub fn cur_dir(&self) -> PathBuf {
    self.root.join("cur")
  }
  pub fn tmp_dir(&self) -> PathBuf {
    self.root.join("tmp")
  }
  pub fn wake_file(&self) -> PathBuf {
    self.root.join("wake")
  }
  pub fn awake_file(&self) -> PathBuf {
    self.root.join("awake")
  }

  /// Creates the inbox's directories where they are missing, its owner's alone.
  pub fn create(&self) -> io::Result<()> {
    for dir in [self.new_dir(), self.cur_dir(), self.tmp_dir()] {
      fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| at(e, &dir))?;
      // An inbox made before its directories were private becomes so.
      fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| at(e, &dir))?;
    }
    Ok(())
  }

  /// Writes the item into `tmp/`, then links it into `new/` under a name no other item has,
  /// so that `new/` only ever holds complete items and no delivery overwrites another.
  pub fn deliver(&self, mut content: impl Read, sender: &str, ext: &str) -> io::Result<PathBuf> {
    self.create()?;
    let sender = encode(sender);
    let ext = ext.trim_start_matches('.');
    if ext.is_empty() || ext.contains('/') {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("invalid extension `{ext}`"),
      ));
    }

    static COUNT: AtomicU64 = AtomicU64::new(0);
    let unique = format!(
      "{}-{}",
      std::process::id(),
      COUNT.fetch_add(1, Ordering::Relaxed)
    );
    let tmp = self.tmp_dir().join(format!(
      "{}.{unique}.{sender}.{ext}",
      format_time(Timestamp::now())
    ));
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .mode(0o600)
      .open(&tmp)
      .map_err(|e| at(e, &tmp))?;
    io::copy(&mut content, &mut file).map_err(|e| at(e, &tmp))?;
    file.sync_all().map_err(|e| at(e, &tmp))?;
    drop(file);

    let mut last = String::new();
    loop {
      let time = format_time(Timestamp::now());
      if time == last {
        continue;
      }
      let path = self.new_dir().join(format!("{time}.{sender}.{ext}"));
      match fs::hard_link(&tmp, &path) {
        Ok(()) => {
          fs::remove_file(&tmp).map_err(|e| at(e, &tmp))?;
          return Ok(path);
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = time,
        Err(e) => return Err(at(e, &path)),
      }
    }
  }

  pub fn dnd_file(&self) -> PathBuf {
    self.root.join("do-not-disturb")
  }

  /// Whether an item rings the bell: its sender proposes, as `proposed`, and the agent's
  /// do-not-disturb settings, the file `do-not-disturb`, dispose. Each of its lines is a rule,
  /// fields to match and then `ring` or `quiet`, such as `session=hive reach=session quiet`, or
  /// `quiet` alone for everything; a field matches where the item has it with that value, the
  /// last rule that matches decides, and where none does, the proposal stands. `#` starts a
  /// comment. A line that is no rule is an error, so no rule is lost unseen.
  pub fn rings(&self, fields: &[(&str, &str)], proposed: bool) -> io::Result<bool> {
    let path = self.dnd_file();
    let rules = match fs::read_to_string(&path) {
      Ok(rules) => rules,
      Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(proposed),
      Err(e) => return Err(at(e, &path)),
    };
    let mut rings = proposed;
    for (n, line) in rules.lines().enumerate() {
      let line = line.split('#').next().unwrap_or_default();
      let mut words: Vec<_> = line.split_whitespace().collect();
      let Some(verdict) = words.pop() else {
        continue;
      };
      let invalid = |what: &str| {
        io::Error::new(
          io::ErrorKind::InvalidData,
          format!("{}:{}: {what}", path.display(), n + 1),
        )
      };
      let verdict = match verdict {
        "ring" => true,
        "quiet" => false,
        _ => return Err(invalid("a rule ends in `ring` or `quiet`")),
      };
      let mut matches = true;
      for word in words {
        let (key, value) = word
          .split_once('=')
          .ok_or_else(|| invalid("a field is `<name>=<value>`"))?;
        matches &= fields.iter().any(|&(k, v)| k == key && v == value);
      }
      if matches {
        rings = verdict;
      }
    }
    Ok(rings)
  }

  /// Whether the agent is not to be disturbed, as others see it: whether a mention, from anyone
  /// in any session, would stay quiet.
  pub fn dnd(&self) -> io::Result<bool> {
    Ok(!self.rings(&[("reach", "ping")], true)?)
  }

  pub fn ring(&self) -> io::Result<()> {
    self.create()?;
    let wake = self.wake_file();
    fs::OpenOptions::new()
      .create(true)
      .append(true)
      .mode(0o600)
      .open(&wake)
      .map_err(|e| at(e, &wake))?;
    Ok(())
  }

  /// Moves every item in `new/` to `cur/`, in order, and returns them.
  /// The move comes first, so that of several concurrent takers exactly one gets each item.
  pub fn take(&self) -> io::Result<Vec<Item>> {
    self.create()?;
    let new = self.new_dir();
    let mut names: Vec<_> = fs::read_dir(&new)
      .map_err(|e| at(e, &new))?
      .map(|entry| entry.map(|entry| entry.file_name()))
      .collect::<Result<_, _>>()
      .map_err(|e| at(e, &new))?;
    names.retain(|name| !name.to_string_lossy().starts_with('.'));
    names.sort();

    let mut items = Vec::new();
    for name in names {
      let path = self.cur_dir().join(&name);
      match fs::rename(new.join(&name), &path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
        Err(e) => return Err(at(e, &path)),
      }
      items.push(read_item(path)?);
    }
    Ok(items)
  }

  /// The oldest item in `new/`, not yet taken in, by its name.
  pub fn oldest_untaken(&self) -> io::Result<Option<OsString>> {
    self.create()?;
    let new = self.new_dir();
    let mut oldest: Option<OsString> = None;
    for entry in fs::read_dir(&new).map_err(|e| at(e, &new))? {
      let name = entry.map_err(|e| at(e, &new))?.file_name();
      if !name.to_string_lossy().starts_with('.') && oldest.as_ref().is_none_or(|o| name < *o) {
        oldest = Some(name);
      }
    }
    Ok(oldest)
  }

  /// Takes the exclusive lock on `awake`, waiting while another holds it:
  /// the agent is awake until the returned file is dropped or the process ends,
  /// and then the system releases the lock, so it never goes stale.
  pub fn hold_awake(&self) -> io::Result<fs::File> {
    self.create()?;
    let path = self.awake_file();
    let file = fs::OpenOptions::new()
      .create(true)
      .append(true)
      .mode(0o600)
      .open(&path)
      .map_err(|e| at(e, &path))?;
    file.lock().map_err(|e| at(e, &path))?;
    Ok(file)
  }

  /// Whether the agent is awake: whether any open file holds the lock on `awake`, in this process or another.
  /// It tests by taking the lock for a moment, during which a `hold_awake` waits.
  pub fn awake(&self) -> io::Result<bool> {
    let path = self.awake_file();
    let file = match fs::File::open(&path) {
      Ok(file) => file,
      Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
      Err(e) => return Err(at(e, &path)),
    };
    match file.try_lock() {
      Ok(()) => Ok(false),
      Err(fs::TryLockError::WouldBlock) => Ok(true),
      Err(fs::TryLockError::Error(e)) => Err(at(e, &path)),
    }
  }

  /// Blocks until the bell rings, then removes `wake`.
  /// Returns at once if it has rung since the last wait.
  pub fn wait(&self) -> io::Result<()> {
    self.until(|inbox| inbox.unring())
  }

  /// Blocks until the bell has rung, leaving `wake` in place for whoever answers it.
  pub fn rung(&self) -> io::Result<()> {
    self.until(|inbox| Ok(inbox.wake_file().exists()))
  }

  /// Removes `wake`: whether the bell had rung, so that of concurrent answerers exactly one does.
  pub fn unring(&self) -> io::Result<bool> {
    let wake = self.wake_file();
    match fs::remove_file(&wake) {
      Ok(()) => Ok(true),
      Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
      Err(e) => Err(at(e, &wake)),
    }
  }

  /// Blocks until `done` holds, testing it at once and at every change in the inbox's root.
  fn until(&self, done: impl Fn(&Self) -> io::Result<bool>) -> io::Result<()> {
    self.create()?;
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).map_err(io::Error::other)?;
    watcher
      .watch(&self.root, RecursiveMode::NonRecursive)
      .map_err(io::Error::other)?;
    while !done(self)? {
      rx.recv()
        .map_err(io::Error::other)?
        .map_err(io::Error::other)?;
    }
    Ok(())
  }
}

/// The extension of a type given as a MIME type, such as `image/png`, or as an extension, such as `png`.
pub fn extension(ty: &str) -> Option<String> {
  let ext = if ty.contains('/') {
    mime2ext::mime2ext(ty)?
  } else {
    ty.trim_start_matches('.')
  };
  Some(ext.to_string()).filter(|ext| !ext.is_empty() && !ext.contains('/'))
}

fn read_item(path: PathBuf) -> io::Result<Item> {
  let name = path
    .file_name()
    .unwrap_or_default()
    .to_string_lossy()
    .into_owned();
  let (time, sender) = match parse_name(&name) {
    Some((time, sender)) => (time, Some(sender)),
    None => {
      let modified = fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| at(e, &path))?;
      (Timestamp::try_from(modified).unwrap_or_default(), None)
    }
  };
  let bytes = fs::read(&path).map_err(|e| at(e, &path))?;
  let content = match String::from_utf8(bytes) {
    Ok(text) => Content::Text(text),
    Err(_) => {
      let mime = mime_guess::from_path(&path)
        .first_raw()
        .filter(|mime| !mime.starts_with("text/"))
        .unwrap_or("application/octet-stream");
      Content::File {
        mime: mime.to_string(),
      }
    }
  };
  Ok(Item {
    path,
    time,
    sender,
    content,
  })
}

fn parse_name(name: &str) -> Option<(Timestamp, String)> {
  let time = name.get(..TIME_LEN)?;
  let rest = name.get(TIME_LEN..)?.strip_prefix('.')?;
  let (sender, _ext) = rest.split_once('.')?;
  let time = DateTime::strptime("%Y%m%dT%H%M%S.%fZ", time)
    .ok()?
    .to_zoned(TimeZone::UTC)
    .ok()?
    .timestamp();
  Some((time, decode(sender)))
}

fn format_time(time: Timestamp) -> String {
  time.strftime(TIME_FORMAT).to_string()
}

/// A sender as it stands in a file name, one to one: no `.`, no `/`.
fn encode(sender: &str) -> String {
  sender
    .bytes()
    .map(|b| match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' => (b as char).to_string(),
      b'/' => "_".to_string(),
      b => format!("%{b:02X}"),
    })
    .collect()
}

/// The sender a file name holds, as `encode` wrote it; anything else is kept as it is.
fn decode(name: &str) -> String {
  let bytes = name.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    let hex = bytes
      .get(i + 1..i + 3)
      .and_then(|h| std::str::from_utf8(h).ok())
      .and_then(|h| u8::from_str_radix(h, 16).ok());
    match (bytes[i], hex) {
      (b'%', Some(byte)) => {
        out.push(byte);
        i += 3;
      }
      (b'_', _) => {
        out.push(b'/');
        i += 1;
      }
      (byte, _) => {
        out.push(byte);
        i += 1;
      }
    }
  }
  String::from_utf8_lossy(&out).into_owned()
}

/// `text` as an attribute's value, on one line: no `"`, `<`, `&` or control character of its own.
fn attribute(text: &str) -> String {
  text
    .chars()
    .map(|c| match c {
      '&' => "&amp;".to_string(),
      '"' => "&quot;".to_string(),
      '<' => "&lt;".to_string(),
      c if c.is_control() => format!("&#{};", c as u32),
      c => c.to_string(),
    })
    .collect()
}

/// `text` as an item's body, which can neither end the item nor open another: every `inbox-item`,
/// in any case and however it is spaced or prefixed, becomes `inbox\-item`.
fn body(text: &str) -> String {
  const TAG: &str = "inbox-item";
  let lower = text.to_ascii_lowercase();
  let mut out = String::with_capacity(text.len());
  let mut last = 0;
  // Every mention of the tag, however it is spaced or prefixed, so that no reader takes one for a
  // boundary: `inbox-item` becomes `inbox\-item`.
  for (i, _) in lower.match_indices(TAG) {
    out.push_str(&text[last..i + 5]);
    out.push('\\');
    last = i + 5;
  }
  out.push_str(&text[last..]);
  out
}

fn at(e: io::Error, path: &Path) -> io::Error {
  io::Error::new(e.kind(), format!("{}: {e}", path.display()))
}

impl Item {
  /// The item as a model reads it: text inline, any other content as its path and type. Nothing
  /// an item holds ends it or adds to its header.
  pub fn render(&self, out: &mut impl Write) -> io::Result<()> {
    let time = self
      .time
      .to_zoned(TimeZone::system())
      .strftime("%Y-%m-%d %H:%M:%S %:z");
    let from = attribute(self.sender.as_deref().unwrap_or("unknown"));
    match &self.content {
      Content::Text(text) => {
        writeln!(out, "<inbox-item from=\"{from}\" time=\"{time}\">")?;
        writeln!(out, "{}", body(text.strip_suffix('\n').unwrap_or(text)))?;
        writeln!(out, "</inbox-item>")
      }
      Content::File { mime } => {
        writeln!(
          out,
          "<inbox-item from=\"{from}\" time=\"{time}\" type=\"{}\" path=\"{}\"/>",
          attribute(mime),
          attribute(&self.path.display().to_string())
        )
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn do_not_disturb_disposes_what_the_sender_proposes() {
    let dir = std::env::temp_dir().join(format!("vibetogether-dnd-{}", std::process::id()));
    let inbox = Inbox::new(&dir);
    inbox.create().unwrap();
    let hive = [("from", "luis"), ("reach", "session"), ("session", "hive")];
    let ping = [("from", "luis"), ("reach", "ping"), ("session", "hive")];
    assert!(inbox.rings(&hive, true).unwrap());
    fs::write(
      inbox.dnd_file(),
      "# listen in the hive\nsession=hive reach=session quiet\n\nfrom=context ring # loud\n",
    )
    .unwrap();
    assert!(!inbox.rings(&hive, true).unwrap());
    assert!(inbox.rings(&ping, true).unwrap());
    assert!(inbox.rings(&[("from", "context")], false).unwrap());
    fs::write(inbox.dnd_file(), "session=hive quiet\nfrom=luis ring\n").unwrap();
    assert!(inbox.rings(&hive, false).unwrap());
    assert!(!inbox.dnd().unwrap());
    fs::write(inbox.dnd_file(), "quiet\nfrom=luis ring\n").unwrap();
    assert!(inbox.dnd().unwrap());
    assert!(inbox.rings(&hive, false).unwrap());
    fs::write(inbox.dnd_file(), "session=hive loud\n").unwrap();
    assert!(inbox.rings(&hive, true).is_err());
    fs::remove_dir_all(&dir).unwrap();
  }
}
