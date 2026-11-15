//! An agent's inbox, Vibe Together's delivery on the agent's machine: a directory like a maildir,
//! which anything local may deliver into too:
//! `new/` holds the items not yet taken in, `cur/` the taken ones, `tmp/` the ones being written,
//! the file `wake` is the doorbell, and a lock on the file `awake` says the agent is in a turn.
//!
//! An item is one file, named `<time>.<sender>.<ext>`, such as `20261115T153012.123456Z.luis.md`,
//! with the time in UTC to the microsecond, so that the names sort by time.

use std::{
  fs, io,
  io::{Read, Write},
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

  /// Creates the inbox's directories where they are missing.
  pub fn create(&self) -> io::Result<()> {
    for dir in [self.new_dir(), self.cur_dir(), self.tmp_dir()] {
      fs::create_dir_all(&dir).map_err(|e| at(e, &dir))?;
    }
    Ok(())
  }

  /// Writes the item into `tmp/`, then links it into `new/` under a name no other item has,
  /// so that `new/` only ever holds complete items and no delivery overwrites another.
  pub fn deliver(&self, mut content: impl Read, sender: &str, ext: &str) -> io::Result<PathBuf> {
    self.create()?;
    let sender = sanitize(sender);
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
    let mut file = fs::File::create_new(&tmp).map_err(|e| at(e, &tmp))?;
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

  pub fn ring(&self) -> io::Result<()> {
    self.create()?;
    let wake = self.wake_file();
    fs::OpenOptions::new()
      .create(true)
      .append(true)
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

  /// Takes the exclusive lock on `awake`, waiting while another holds it:
  /// the agent is awake until the returned file is dropped or the process ends,
  /// and then the system releases the lock, so it never goes stale.
  pub fn hold_awake(&self) -> io::Result<fs::File> {
    self.create()?;
    let path = self.awake_file();
    let file = fs::OpenOptions::new()
      .create(true)
      .append(true)
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
    self.create()?;
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).map_err(io::Error::other)?;
    watcher
      .watch(&self.root, RecursiveMode::NonRecursive)
      .map_err(io::Error::other)?;
    let wake = self.wake_file();
    loop {
      match fs::remove_file(&wake) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(at(e, &wake)),
      }
      rx.recv()
        .map_err(io::Error::other)?
        .map_err(io::Error::other)?;
    }
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
  Some((time, sender.to_string()))
}

fn format_time(time: Timestamp) -> String {
  time.strftime(TIME_FORMAT).to_string()
}

/// A sender as it can stand in a file name: no `.`, no `/`, never empty.
fn sanitize(sender: &str) -> String {
  let sender: String = sender
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
        c
      } else {
        '-'
      }
    })
    .collect();
  if sender.is_empty() {
    "unknown".to_string()
  } else {
    sender
  }
}

fn at(e: io::Error, path: &Path) -> io::Error {
  io::Error::new(e.kind(), format!("{}: {e}", path.display()))
}

impl Item {
  /// The item as a model reads it: text inline, any other content as its path and type.
  pub fn render(&self, out: &mut impl Write) -> io::Result<()> {
    let time = self
      .time
      .to_zoned(TimeZone::system())
      .strftime("%Y-%m-%d %H:%M:%S %:z");
    let from = self.sender.as_deref().unwrap_or("unknown");
    match &self.content {
      Content::Text(text) => {
        writeln!(out, "<inbox-item from=\"{from}\" time=\"{time}\">")?;
        writeln!(out, "{}", text.strip_suffix('\n').unwrap_or(text))?;
        writeln!(out, "</inbox-item>")
      }
      Content::File { mime } => {
        writeln!(
          out,
          "<inbox-item from=\"{from}\" time=\"{time}\" type=\"{mime}\" path=\"{}\"/>",
          self.path.display()
        )
      }
    }
  }
}
