//! An entry's type, a MIME type, and the parameters a message names participants in.

/// A parameter of a MIME type, such as `ping` of `text/plain; ping="ben ben/claude"`, read as
/// RFC 9110 reads it: a quoted value holds what would otherwise end it, the first of a name
/// counts, and reading stops at the first malformed parameter.
pub fn parameter_of(ty: &str, name: &str) -> Option<String> {
  let mut rest = &ty[ty.find(';')?..];
  loop {
    rest = rest.strip_prefix(';')?.trim_start();
    let end = rest
      .find(|c: char| c == '=' || c == ';' || c.is_whitespace())
      .unwrap_or(rest.len());
    if end == 0 {
      return None;
    }
    let (key, after) = rest.split_at(end);
    let after = after.trim_start().strip_prefix('=')?.trim_start();
    let (value, after) = match after.strip_prefix('"') {
      Some(quoted) => unquoted(quoted)?,
      None => {
        let end = after
          .find(|c: char| c == ';' || c.is_whitespace())
          .unwrap_or(after.len());
        (after[..end].to_string(), &after[end..])
      }
    };
    if key.eq_ignore_ascii_case(name) {
      return Some(value);
    }
    rest = after.trim_start();
  }
}

/// A quoted string's value up to its closing quote, with what follows it; `None` where it never
/// closes.
fn unquoted(quoted: &str) -> Option<(String, &str)> {
  let mut value = String::new();
  let mut chars = quoted.char_indices();
  while let Some((i, c)) = chars.next() {
    match c {
      '"' => return Some((value, &quoted[i + 1..])),
      '\\' => value.push(chars.next()?.1),
      c => value.push(c),
    }
  }
  None
}

/// The names the parameter `name` of `ty` lists, separated by spaces.
pub fn names_of(ty: &str, name: &str) -> Vec<String> {
  parameter_of(ty, name)
    .unwrap_or_default()
    .split_whitespace()
    .map(str::to_string)
    .collect()
}

/// Whether an entry of type `ty` is a message, rather than an extension's, whose subtype starts
/// with `vnd.`.
pub fn is_message(ty: &str) -> bool {
  let essence = ty.split(';').next().unwrap_or_default();
  let subtype = essence.split('/').nth(1).unwrap_or_default().trim();
  !subtype.to_ascii_lowercase().starts_with("vnd.")
}

/// A message's type: `base` with whom it pings, where `ping` is given, and whom it tells
/// quietly. A message without `ping` pings everyone in its session; with an empty one, no one.
pub fn message_type(base: &str, ping: Option<&[String]>, fyi: &[String]) -> String {
  let quoted = |names: &[String]| {
    let joined = names.join(" ");
    format!("\"{}\"", joined.replace('\\', "\\\\").replace('"', "\\\""))
  };
  let mut ty = base.to_string();
  if let Some(ping) = ping {
    ty += &format!("; ping={}", quoted(ping));
  }
  if !fyi.is_empty() {
    ty += &format!("; fyi={}", quoted(fyi));
  }
  ty
}
