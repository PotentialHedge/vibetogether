//! An entry's type, a MIME type, and the parameters a message names participants in.

use std::ops::Range;

/// A parameter of a MIME type, such as `ping` of `text/plain; ping="ben ben/claude"`, read as
/// RFC 9110 reads it: a quoted value holds what would otherwise end it, the first of a name
/// counts, and reading stops at the first malformed parameter.
pub fn parameter_of(ty: &str, name: &str) -> Option<String> {
  parameters(ty)
    .into_iter()
    .find(|(key, _, _)| key.eq_ignore_ascii_case(name))
    .map(|(_, value, _)| value)
}

/// The parameters of `ty` up to the first malformed one, each with its value and where the
/// value stands in `ty`, quotes included.
fn parameters(ty: &str) -> Vec<(&str, String, Range<usize>)> {
  let mut found = Vec::new();
  let Some(start) = ty.find(';') else {
    return found;
  };
  let at = |rest: &str| ty.len() - rest.len();
  let mut rest = &ty[start..];
  loop {
    let Some(next) = rest.strip_prefix(';') else {
      return found;
    };
    rest = next.trim_start();
    let end = rest
      .find(|c: char| c == '=' || c == ';' || c.is_whitespace())
      .unwrap_or(rest.len());
    if end == 0 {
      return found;
    }
    let (key, after) = rest.split_at(end);
    let Some(after) = after.trim_start().strip_prefix('=') else {
      return found;
    };
    let after = after.trim_start();
    let from = at(after);
    let (value, after) = match after.strip_prefix('"') {
      Some(quoted) => match unquoted(quoted) {
        Some(read) => read,
        None => return found,
      },
      None => {
        let end = after
          .find(|c: char| c == ';' || c.is_whitespace())
          .unwrap_or(after.len());
        (after[..end].to_string(), &after[end..])
      }
    };
    found.push((key, value, from..at(after)));
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

/// `ty` with each name its `ping` and `fyi` list as `rename` gives it, the rest as it was.
pub fn renamed(ty: &str, rename: impl Fn(&str) -> String) -> String {
  let mut out = String::new();
  let mut at = 0;
  for (key, value, span) in parameters(ty) {
    if key.eq_ignore_ascii_case("ping") || key.eq_ignore_ascii_case("fyi") {
      let names: Vec<String> = value.split_whitespace().map(&rename).collect();
      out += &ty[at..span.start];
      out += &quoted(&names);
      at = span.end;
    }
  }
  out + &ty[at..]
}

/// Names as a quoted parameter's value, separated by spaces.
fn quoted(names: &[String]) -> String {
  let joined = names.join(" ");
  format!("\"{}\"", joined.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A message's type: `base` with whom it pings, where `ping` is given, and whom it tells
/// quietly. A message without `ping` pings everyone in its session; with an empty one, no one.
pub fn message_type(base: &str, ping: Option<&[String]>, fyi: &[String]) -> String {
  let mut ty = base.to_string();
  if let Some(ping) = ping {
    ty += &format!("; ping={}", quoted(ping));
  }
  if !fyi.is_empty() {
    ty += &format!("; fyi={}", quoted(fyi));
  }
  ty
}

/// The names `text` mentions, each once, in order: every `@name` at the start or after
/// whitespace, not followed by a word character, `/` or `-`, where `name` is a login or an
/// agent's `<login>/<agent>`, and `*` for `@everyone`. It stops one past `MAX_NAMED`, enough for
/// a message that names too many to be refused, so that a long text costs no more than its scan.
pub fn mentions(text: &str) -> Vec<String> {
  let part = |s: &str| -> usize {
    let mut end = 0;
    for (i, c) in s.char_indices() {
      let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && c == '-');
      if !ok {
        break;
      }
      end = i + c.len_utf8();
    }
    end
  };
  let mut found: Vec<String> = Vec::new();
  let mut prev: Option<char> = None;
  for (i, c) in text.char_indices() {
    let starts = c == '@' && prev.is_none_or(char::is_whitespace);
    prev = Some(c);
    if !starts {
      continue;
    }
    let rest = &text[i + 1..];
    let mut end = part(rest);
    if end == 0 {
      continue;
    }
    if let Some(agent) = rest[end..].strip_prefix('/') {
      let more = part(agent);
      if more > 0 {
        end += 1 + more;
      }
    }
    let after = rest[end..].chars().next();
    if after.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '/' || c == '-') {
      continue;
    }
    // A name longer than any real one is no mention, so it adds nothing to the type.
    if !rest[..end].split('/').all(crate::is_name_part) {
      continue;
    }
    let name = match &rest[..end] {
      "everyone" => "*".to_string(),
      name => name.to_string(),
    };
    if !found.contains(&name) {
      found.push(name);
      if found.len() > crate::MAX_NAMED {
        break;
      }
    }
  }
  found
}

/// The mention that starts a message which wakes no one, as in Discord: whom it mentions it
/// tells quietly.
pub const SILENT: &str = "silent";

/// A text message's type as its text says whom it reaches, the one way people and agents alike
/// name them: every name it mentions as `@name` is added to its `ping`, so that no client can send
/// a mention that reaches no one; one that starts with `@silent` pings no one and tells whom it
/// mentions quietly, in its `fyi`. A type without `ping` that mentions no one stays as it is, and
/// pings everyone in its session.
pub fn with_mentions(ty: &str, text: &str) -> String {
  let essence = ty.split(';').next().unwrap_or_default().trim();
  if !is_message(ty) || !essence.to_ascii_lowercase().starts_with("text/") {
    return ty.to_string();
  }
  let mut mentioned = mentions(text);
  let silent = mentioned.first().is_some_and(|name| name == SILENT)
    && text.trim_start().starts_with(&format!("@{SILENT}"));
  if silent {
    mentioned.remove(0);
  }
  if mentioned.is_empty() && !silent {
    return ty.to_string();
  }
  let (key, mut names) = if silent {
    ("fyi", names_of(ty, "fyi"))
  } else {
    ("ping", names_of(ty, "ping"))
  };
  for name in mentioned {
    if !names.contains(&name) {
      names.push(name);
    }
  }
  let mut out = String::new();
  let mut at = 0;
  for (k, _, span) in parameters(ty) {
    if k.eq_ignore_ascii_case(key) || (silent && k.eq_ignore_ascii_case("ping")) {
      let start = ty[..span.start].rfind(';').unwrap_or(span.start);
      out += &ty[at..start];
      at = span.end;
    }
  }
  out += &ty[at..];
  if silent {
    out += "; ping=\"\"";
  }
  if !names.is_empty() {
    out += &format!("; {key}={}", quoted(&names));
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_mention_pings() {
    assert_eq!(
      mentions("@vt-builder look, and @luiswirth/lead too; @everyone. a@b, @x_y, @Up"),
      ["vt-builder", "luiswirth/lead", "*"]
    );
    assert_eq!(
      with_mentions("text/markdown; charset=utf-8", "@vt-builder go"),
      "text/markdown; charset=utf-8; ping=\"vt-builder\""
    );
    assert_eq!(
      with_mentions("text/markdown; ping=\"\"", "@lead and @lead"),
      "text/markdown; ping=\"lead\""
    );
    assert_eq!(
      with_mentions("text/markdown; ping=\"ben\"; fyi=\"tristan\"", "hi @lead"),
      "text/markdown; fyi=\"tristan\"; ping=\"ben lead\""
    );
    assert_eq!(
      with_mentions("text/markdown; charset=utf-8", "@silent @ben look"),
      "text/markdown; charset=utf-8; ping=\"\"; fyi=\"ben\""
    );
    assert_eq!(
      with_mentions("text/markdown; ping=\"*\"", "  @silent update"),
      "text/markdown; ping=\"\""
    );
    assert_eq!(
      with_mentions("text/markdown", "not @silent here"),
      "text/markdown; ping=\"silent\""
    );
    assert_eq!(with_mentions("text/markdown", "no one"), "text/markdown");
    assert_eq!(with_mentions("image/png", "@lead"), "image/png");
    let many: String = (0..100_000).map(|i| format!("@a{i} ")).collect();
    assert_eq!(mentions(&many).len(), crate::MAX_NAMED + 1);
    assert!(mentions(&format!("@{}", "a".repeat(300))).is_empty());
  }
}
