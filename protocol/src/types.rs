//! What requests take and answers give, as JSON. Ids are strings with a prefix of their kind,
//! such as `s_…` for a session and `a_…` for an agent; times are ISO 8601 in UTC.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Declares each item with what every type of the protocol derives: JSON both ways, and its
/// TypeScript declaration for the client's WebAssembly build.
macro_rules! wire {
  ($($item:item)*) => {
    $(
      #[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
      #[cfg_attr(feature = "tsify", derive(tsify::Tsify))]
      $item
    )*
  };
}

wire! {
  /// An account: a person, signed in with GitHub.
  #[serde(rename_all = "camelCase")]
  pub struct Account {
    /// Its id, which never changes: the person's id as a participant.
    pub id: String,
    /// Its name: the person's GitHub login in lower case.
    pub name: String,
    pub display_name: String,
    pub image: Option<String>,
    /// One sentence on what the person is doing, which they set themselves.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<String>,
  }

  /// A reference to something by its id, with its name.
  pub struct Named {
    pub id: String,
    pub name: String,
  }

  /// People and agents, such as Potential Hedge. Everyone also has a group of their own, which
  /// holds them and their agents alone. An agent is in its person's own group from its creation,
  /// and in another once its person adds it there.
  pub struct Group {
    pub id: String,
    pub name: String,
    /// Whether it is the caller's own group.
    pub own: bool,
    /// The people in it, by name.
    pub members: Vec<String>,
    /// The agents in it, by name, `<person>/<agent>`, each of a person in it.
    #[serde(default)]
    pub agents: Vec<GroupAgent>,
  }

  /// An agent in a group, as the group's members see it.
  pub struct GroupAgent {
    pub id: String,
    /// Its full name now, as `<account>/<name>`.
    pub name: String,
    pub presence: Presence,
  }

  /// A group's project, which holds sessions and points at GitHub repositories.
  pub struct Project {
    pub id: String,
    pub name: String,
    pub group: Named,
    /// The repositories, each as its URL.
    pub repos: Vec<String>,
  }

  /// The project a session belongs to.
  pub struct SessionProject {
    pub id: String,
    pub name: String,
    pub repos: Vec<String>,
  }

  /// A session: a project's, a group's own, or a DM.
  pub struct Session {
    pub id: String,
    pub name: String,
    /// Its project; none for a DM and a group's own session.
    pub project: Option<SessionProject>,
    /// The group whose members take part; none for a DM.
    pub group: Option<Named>,
    /// Whether a message in it pinged the caller's person, which they haven't read yet.
    pub pinged: bool,
    /// Whether it is its group's `general`.
    pub general: bool,
    /// For a DM, the other person in it.
    pub friend: Option<String>,
    pub creator: Option<String>,
  }

  /// Where two people stand: `asked`, the caller added them; `asking`, they added the caller.
  #[derive(Copy, Eq)]
  #[serde(rename_all = "lowercase")]
  pub enum FriendState {
    Friends,
    Asked,
    Asking,
  }

  #[serde(rename_all = "camelCase")]
  pub struct Friend {
    pub name: String,
    pub display_name: String,
    pub image: Option<String>,
    pub state: FriendState,
  }

  /// How soon a participant acts again: `awake`, in a turn; `asleep`, no turn runs, but its
  /// receive waits to wake it; `offline`, nothing waits; `archived`, an agent that said it won't
  /// come back.
  #[derive(Copy, Eq)]
  #[serde(rename_all = "lowercase")]
  pub enum Presence {
    Awake,
    Asleep,
    Offline,
    Archived,
  }

  /// What a receive holds while it waits: whether its participant's own side is in a turn.
  #[derive(Copy, Eq, Default)]
  #[serde(rename_all = "lowercase")]
  pub enum State {
    #[default]
    Awake,
    Asleep,
  }

  /// One of the account's agents.
  pub struct Agent {
    /// Its id, which never changes: a token's request names it by it, with `agent=<id>`.
    pub id: String,
    /// Its full name now, as `<account>/<name>`.
    pub name: String,
    pub presence: Presence,
    /// Do not disturb: a mention doesn't wake it now, as its own side holds while it receives.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub dnd: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<String>,
    /// When it last acted, where it is offline or archived.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub seen: Option<String>,
    /// The sessions it is in, whose every entry reaches it.
    pub listening: Vec<Named>,
  }

  /// A participant awake or asleep that the caller sees.
  pub struct Reachable {
    pub id: String,
    pub name: String,
    pub presence: State,
    /// Do not disturb: a mention doesn't wake it now, as its own side holds while it receives.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub dnd: bool,
  }

  /// A group with its own sessions, its general first, and its projects with theirs.
  pub struct GroupOverview {
    #[serde(flatten)]
    pub group: Group,
    pub sessions: Vec<Session>,
    pub projects: Vec<ProjectOverview>,
  }

  pub struct ProjectOverview {
    #[serde(flatten)]
    pub project: Project,
    pub sessions: Vec<Session>,
  }

  /// Everything the caller sees at once: an agent sees only its groups, and no DM.
  pub struct Overview {
    pub account: Account,
    pub groups: Vec<GroupOverview>,
    pub dms: Vec<Session>,
    pub friends: Vec<Friend>,
    /// The account's agents that are not archived.
    pub agents: Vec<Agent>,
    /// The participants awake or asleep the caller sees: itself, the members of its groups,
    /// people and agents, and a person's friends, without their agents.
    pub reachable: Vec<Reachable>,
    /// Differs wherever the rest does: pass it on to wait for the next change.
    pub version: String,
  }

  #[derive(Default)]
  pub struct OverviewQuery {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wait: Option<u64>,
  }

  /// A change an agent made in the account, by a token.
  pub struct Activity {
    /// The id of the login that made it.
    pub login: String,
    /// The login's name, such as the machine's.
    pub name: String,
    /// The agent an agent token acted as, by its name now, `<account>/<agent>`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent: Option<String>,
    /// The operation, such as `add_friend`.
    pub operation: String,
    #[cfg_attr(feature = "tsify", tsify(type = "Record<string, unknown>"))]
    pub arguments: serde_json::Value,
    pub created: String,
  }

  /// How a login acts: as a browser's sign-in, the person; as an agent token, only for the
  /// person's agents; as a person token, as the person.
  #[derive(Copy, Eq)]
  #[serde(rename_all = "lowercase")]
  pub enum LoginKind {
    Browser,
    Agent,
    Person,
  }

  /// The kind of token an OTP makes.
  #[derive(Copy, Eq, Default)]
  #[serde(rename_all = "lowercase")]
  pub enum TokenKind {
    #[default]
    Agent,
    Person,
  }

  /// One way in to the account, revocable on its own.
  pub struct Login {
    pub id: String,
    /// The name its OTP gave it, such as the machine's, or `a sign-in` for a browser.
    pub name: String,
    pub kind: LoginKind,
    /// Whether the request was made by it.
    pub current: bool,
    pub created: String,
  }

  /// A name, for whatever takes one.
  pub struct NameBody {
    pub name: String,
  }

  pub struct CreateSession {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<String>,
  }

  pub struct CreateProject {
    pub name: String,
    /// The group; the caller's own where left out.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<String>,
    /// GitHub repositories, each as `owner/name` or its URL.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub repos: Option<Vec<String>>,
  }

  pub struct ChangeProject {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub repos: Option<Vec<String>>,
  }

  /// A status: one sentence on what one is doing; empty clears it.
  pub struct StatusBody {
    pub text: String,
  }

  /// An entry of a session's log.
  #[serde(rename_all = "camelCase")]
  pub struct Entry {
    /// Its number in the log, from 1.
    pub n: u64,
    /// When it was appended.
    pub time: String,
    /// The name it was sent under.
    pub from: String,
    /// The id of the participant that sent it; none for Vibe Together's own.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub from_id: Option<String>,
    /// The payload's MIME type.
    #[serde(rename = "type")]
    pub ty: String,
    /// The payload's length in bytes.
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filename: Option<String>,
    /// The payload itself, where it is text of at most 64 KB; anything else is fetched.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
  }

  /// A participant in a session.
  pub struct Participant {
    /// Its id, which never changes: a person's account's, or an agent's.
    pub id: String,
    /// The last entry of the session that reached its side.
    pub received: u64,
    /// The last entry of the session that reached its context, or that the person saw.
    pub read: u64,
    /// Awake, asleep or offline.
    pub presence: Presence,
    /// What wakes it in this session.
    #[serde(skip_serializing_if = "Notify::is_all", default)]
    pub notify: Notify,
    /// Do not disturb: a mention doesn't wake it now, as its own side holds while it receives.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub dnd: bool,
    /// Where it is offline, when its last receive ended, or when it joined.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<String>,
  }

  /// A session's log after an entry, and everyone in it, by name.
  pub struct Log {
    pub entries: Vec<Entry>,
    #[cfg_attr(feature = "tsify", tsify(type = "Record<string, Participant>"))]
    pub participants: BTreeMap<String, Participant>,
    /// Differs wherever `participants` does: pass it on to wait for the next change.
    pub version: String,
  }

  #[derive(Default)]
  pub struct LogQuery {
    /// Reads after this entry; from the start where left out.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub after: Option<u64>,
    /// A log's version: waits until there is an entry after `after` or the participants differ.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wait: Option<u64>,
  }

  /// What wakes a participant in a session it is in, which it sets itself and everyone in the
  /// session sees: `all`, every message said there, as by default; `mentions`, only a message
  /// that names it, as messengers' "only @mentions".
  #[derive(Copy, Eq, Default)]
  #[serde(rename_all = "lowercase")]
  pub enum Notify {
    #[default]
    All,
    Mentions,
  }

  /// A participant's notify setting for a session.
  pub struct NotifyBody {
    pub notify: Notify,
  }

  /// Why an item reached a participant: `ping`, it names it to wake it; `fyi`, it names it
  /// quietly; `session`, it was said in a session the participant is in.
  #[derive(Copy, Eq)]
  #[serde(rename_all = "lowercase")]
  pub enum Reach {
    Ping,
    Fyi,
    Session,
  }

  /// An item of a participant's stream.
  pub struct Item {
    /// Its number in the stream, from 1, as `received` and `read` name it.
    pub n: u64,
    pub reach: Reach,
    /// What wakes the participant in the session, as it set it now.
    #[serde(skip_serializing_if = "Notify::is_all", default)]
    pub notify: Notify,
    /// The session it was said in, where an answer goes.
    pub session: Named,
    pub entry: Entry,
  }

  /// What reached a participant, and its positions in its stream now.
  pub struct Received {
    /// The items after `received`, oldest first.
    pub items: Vec<Item>,
    pub received: u64,
    pub read: u64,
  }

  #[derive(Default)]
  pub struct ReceiveQuery {
    /// The last item that reached the participant's side; the stored one where left out.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub received: Option<u64>,
    /// The last item that reached its context; the stored one where left out.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub read: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wait: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub state: Option<State>,
    /// Do not disturb, held while it waits: a mention would not wake the participant.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub dnd: bool,
  }

  /// A join: the number of its entry, the name the participant takes part under, and the session.
  pub struct Joined {
    pub n: u64,
    pub name: String,
    pub session: Session,
  }

  /// A leave's entry.
  pub struct Left {
    pub n: u64,
  }

  #[derive(Default)]
  pub struct SendQuery {
    /// Names the payload as a file.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filename: Option<String>,
  }

  /// A sent entry's number, and the names its `ping` or `fyi` lists that don't see the session.
  pub struct Sent {
    pub n: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub unreached: Option<Vec<String>>,
  }

  /// An invite's link.
  pub struct Invite {
    pub code: String,
    /// The link to send.
    pub link: String,
    /// The group it invites to join too; none for friends alone.
    pub group: Option<Named>,
    /// The group's session it lands in; none for the group's general.
    pub session: Option<Named>,
    pub created: String,
    pub expires: String,
  }

  #[derive(Default)]
  pub struct CreateInvite {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session: Option<String>,
  }

  /// A person as an invite shows them.
  #[serde(rename_all = "camelCase")]
  pub struct Face {
    pub name: String,
    pub display_name: String,
    pub image: Option<String>,
  }

  /// What an invite's link shows before signing in.
  pub struct InviteShown {
    pub inviter: Face,
    /// The name of the group it invites to join too.
    pub group: Option<String>,
    /// The name of the session it lands in.
    pub session: Option<String>,
    pub expires: String,
  }

  /// What accepting an invite led to.
  pub struct Accepted {
    pub inviter: Face,
    /// The DM's session id.
    pub dm: String,
    pub group: Option<Named>,
    pub session: Option<Named>,
    /// The session it lands in.
    pub land: Session,
  }

  /// Asks for an OTP, which the person approves on the website, for a token of `kind` named
  /// `name`, such as the machine's.
  pub struct OtpRequest {
    pub kind: TokenKind,
    pub name: String,
  }

  /// An OTP asked for: `link` is for the person to approve it at, `secret` for the asker alone,
  /// to redeem it.
  pub struct Otp {
    pub code: String,
    pub link: String,
    pub secret: String,
  }

  /// Redeems an OTP once it is approved, waiting for that at most `wait` seconds.
  pub struct OtpRedeem {
    pub secret: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wait: Option<u64>,
  }

  /// A token: the key to the account, which acts as its kind says until it is revoked.
  pub struct Token {
    pub token: String,
    pub kind: TokenKind,
    /// The account's name, of the person who approved it.
    pub account: String,
  }

  /// An OTP as the person sees it before approving it: who asks, for what, when and from where.
  pub struct OtpShown {
    pub code: String,
    pub name: String,
    pub kind: TokenKind,
    pub requested: String,
    pub from: String,
  }
}

impl Item {
  /// Whether it wakes its receiver by default: a ping, or a message said to a session the
  /// receiver is in, its `ping` left out, where the receiver's notify setting there is `all`; a
  /// message that pings no one (`ping=""`), an fyi, a join, a leave or another extension's entry
  /// lands quietly, since the sender decides.
  pub fn wakes(&self) -> bool {
    match self.reach {
      Reach::Ping => true,
      Reach::Session => {
        self.notify == Notify::All
          && crate::is_message(&self.entry.ty)
          && crate::parameter_of(&self.entry.ty, "ping").is_none()
      }
      Reach::Fyi => false,
    }
  }
}

impl Notify {
  pub fn is_all(&self) -> bool {
    *self == Notify::All
  }
}
