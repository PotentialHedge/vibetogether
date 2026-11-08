//! Chat's pings, as `https://vibetogether.agentics.lwirth.com/specs/chat.md` defines them:
//! a `ping` parameter of a message's type names whom it wakes,
//! as names separated by spaces, or `*` for everyone.
//! Everyone gets every message; whom it doesn't ping gets it as an fyi.

use std::fmt;

/// Whom a message pings, by its `ping` parameter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ping {
    Everyone,
    /// These names alone; none for no one.
    Only(Vec<String>),
}

impl Ping {
    /// The `ping` parameter of `kind`, or `None` where it has none,
    /// which for a message means everyone.
    pub fn of(kind: &str) -> Option<Self> {
        let value = crate::parameter(kind, "ping")?;
        let names: Vec<String> = value.split_whitespace().map(str::to_owned).collect();
        Some(if names.iter().any(|name| name == "*") {
            Self::Everyone
        } else {
            Self::Only(names)
        })
    }

    /// Whether it pings `name`.
    pub fn pings(&self, name: &str) -> bool {
        match self {
            Self::Everyone => true,
            Self::Only(names) => names.iter().any(|pinged| pinged == name),
        }
    }

    /// `kind` with this as its `ping` parameter, such as `text/markdown; ping="luis"`.
    pub fn on(&self, kind: &str) -> String {
        format!("{kind}; ping=\"{self}\"")
    }

    /// Whether a name can be pinged: a name holds no space, quote or `*`.
    pub fn valid(name: &str) -> bool {
        !name.is_empty() && !name.contains(|c: char| c.is_whitespace() || c == '"' || c == '*')
    }
}

impl fmt::Display for Ping {
    /// The parameter's value.
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Everyone => f.write_str("*"),
            Self::Only(names) => f.write_str(&names.join(" ")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Ping;

    #[test]
    fn pings_are_read() {
        assert_eq!(Ping::of("text/plain"), None);
        assert_eq!(Ping::of(r#"text/plain; ping="""#), Some(Ping::Only(vec![])));
        assert_eq!(Ping::of(r#"text/plain; ping="a *""#), Some(Ping::Everyone));
        let ping = Ping::of(r#"text/markdown; ping="luis luis/claude""#).unwrap();
        assert!(ping.pings("luis/claude"));
        assert!(!ping.pings("ben"));
    }

    #[test]
    fn a_ping_is_written() {
        let ping = Ping::Only(vec!["luis".into(), "ben/claude".into()]);
        assert_eq!(
            ping.on("text/markdown"),
            r#"text/markdown; ping="luis ben/claude""#
        );
        assert_eq!(Ping::of(&ping.on("text/markdown")), Some(ping));
        assert_eq!(
            Ping::Only(vec![]).on("text/plain"),
            r#"text/plain; ping="""#
        );
    }
}
