# messagent

Message and call your agent in a messaging app, like a friend.
"messagent" is the name, Luis's decision.
The flagship for now, Luis's decision: "the messenger chat is soooo simple. everybody will udnerstand it."
It may subsume voice mode.
A piece of Ag² (`~/dev/agentics`), in a public repository of its own, Luis's decision.

## Decided

- It is a product for other people, for Ag², before it is for Luis, and it is zero-setup and free, Luis's decision:
  anything that costs the user money or needs steps on their side is a non-starter.
- It is the actual phone experience, Luis's decision: Discord is no fit as the main messenger, since it is not a phone messenger people are used to.
- The UI is the messenger: no UI of our own, everything is infrastructure and backend, Luis's decision.
- It is built on Vibe Together, Luis's decision (2026-11-06), replacing "without polylogue for now":
  messagent is a participant in a Vibe Together room, Luis's framing: it carries the messenger chat in and out, as Vibe Together's chat extension,
  as programs and engines are participants (vibetogether-project's `direction.md`).
  It joins as the user; the agent joins the room as any agent does.
  agentwire is only the transport underneath, the session and its delivery: messagent is a Vibe Together participant, not an agentwire product.
- It uses the public relay by default, Luis's decision, rather than a relay on the user's machine:
  it is more unified, since a remote participant joins the same room, and most people "just want things to work zero-setup".
- It is agnostic to the messenger, Luis's decision: each messenger connects on top with the capabilities it has.
- It embraces how people already use each messenger, Luis's decision: "we should embrace the way people interact with messangers/platforms as much as possible."
- The capabilities are traits, Luis's decision: `Messages`, finished pieces of content in the modalities the messenger carries,
  and `Calls`, live audio both ways.
  A voice note is a message with audio content.
- Images are first-class, both ways, Luis's decision (2026-11-08): "messagent should get first-class image support".
  An image is an entry of its own image type, as agentwire carries any payload.
- Reacting to messages is an additional, optional capability of a messenger, Luis's decision.
- A message the agent has read gets 👀, Luis's decision: "so it's not only received but acutally seen by an agent/llm."
- The agent can react to the user's messages itself, Luis's decision, through an entry type of a reactions extension.
- The agent writes in each messenger's own format, passed through raw, Luis's decision:
  "just let telegram do all the things. the agent should just write whatever each messager can accept. fully raw, full power, nothing custom".
- Agents never have to keep calling something to show they are typing, Luis's decision.
  No typing indicator for now, Luis's decision: "not needed".
- The agent reaches messagent only through the Vibe Together room, with a command line: curl or the `agentwire` script.
  CLIs are preferred, Luis's decision: "CLI are the way to go in gerneral for harness-agnostic things."
  Every agent has a shell, Luis's decision: "a agent that cannot use a shell is not an agent in my definition".
- Voice notes use the speech engines of voice mode, ElevenLabs and local, Luis's decision.
- It runs on the user's machine, where their agent already runs, Luis's decision; for Telegram superseded by the shared bot (2026-11-09).
  We host as little as possible, for cost and maintenance.
- Discord was tried for calls and dropped, Luis's decision: it is not the phone experience, and every user would make an app by hand.
  The try is in the history of messagent#1.
- Calls use voice's core, Luis's decision: conversational voice mode, with dictation and read-aloud as its special cases, is a standalone component without transport or UI.
  A call's voice is the voice engine, a participant of its own in the session, Luis's decision.
  Telegram bots can't call.
- One log in time order, each entry tagged with the channel it came by, typed or spoken, Luis's decision: the session's log.
- Telegram first, as a bot that is a contact of its own, with voice notes for now, Luis's decision.
  WhatsApp is not pursued for now: its setup and its rules on AI make it a hassle.
  Phone numbers for an agent's own account wait until a Telegram bot's limits are reached.
- Superseded by the shared bot (2026-11-09): onboarding creates the bot, through Telegram's managed bots, Luis's decision.
  The manager bot is ours to host, kept tiny.
  It runs on lwirth-cloud, where everything public of Ag² runs, Luis's decision.
  Telegram Serverless can't host it: a machine can't reach a Serverless bot from outside, so it couldn't hand the token over.
  The user connects a phone by scanning a QR code, or by typing a code once.
- We are trustworthy to the user and to the user's agent, Luis's decision.
  Agents run in terminals and in GUIs alike, so onboarding assumes neither.
- Setup is a conversation with the agent, which acts as the setup flow, rather than a website, Luis's decision:
  "everything done through the agent", which he sees as a cool idea for all of Ag².
- Installing and wiring messagent is the user's agent's work: the agent is the setup wizard, Luis's decision.
  It keeps the user in the loop and applies the user's policies, if any exist, rather than doing what the user might not want.
  What an agent without context does by default is to be checked.
- What we hand out is a prompt, which points the agent at the resources it reads, Luis's decision.
  Its page for people, `messagent.agentics.lwirth.com`, a domain of its own as every client has, shows the prompt most prominently, with a little explanation, and is nice to look at.

- One shared Vibe Together bot for everyone, Luis's agreement (2026-11-09), replacing "one bot is one agent":
  The person opens the bot, which sends them the generic approval page, "messagent wants to act as you", where they approve signed in, Luis's decision (2026-11-09), replacing a start-code link the agent hands over:
  no link that makes its holder the person ever passes through an agent.
  The account page knows nothing of any app, Luis: "i don't think the account page should know any specifics of any apps".
  The bot joins as the verified person, Luis's approval (2026-11-09) of "messagent wants to act as you".
  The linking follows industry practice, the OAuth device flow (RFC 8628) as GitHub and Google run it, Luis's decision (2026-11-09): "let's just follow industry practice".
  One approval and nothing typed back: the bot shows the code in the chat, and the page shows it with the asking Telegram id and @username, so the person checks they match.
  The link's credential lasts until it is unlinked, with no expiry, Luis's agreement (2026-11-09).
- One conversation in an app is one session, such as a Telegram chat, private or a group, or a Discord channel, Luis's agreement (2026-11-09).
  Superseded where messagent owns the session, by the bridge below: linking created a members-only session for the private chat, owned by the person.

- messagent is a bridge, Luis's decisions (2026-11-10, Vibe Together's design): it mirrors a messenger chat and a Vibe Together session onto each other, owns no session, and is added to one, as a client joins one.
  This supersedes "messagent wants to act as you" and the app's own sessions above.
  - A bridge passes everything both ways, so the bot's group privacy mode is off, which Luis switched off in BotFather.
  - A person's Telegram messages show as them once they have linked their Telegram account by OTP.
  - Every session is members only, and there is no tier without an account.
  - The plan, approved by ag2 (2026-11-10, its speech 236596 on vt-messagent's 236576): /start in a chat, private or a group, asks for an OTP with the scope `bridge`, saying what the chat is; a member approves signed in and picks one of their sessions; the bridge joins only that session, as `<member>/messagent` for now, while that member is in its group.
    Linking a Telegram account happens once, by the OTP from the person's private chat with the bot; everyone else's messages come from the bridge, named and marked unverified, and the bot tells the session its audience.
    Superseded by the grant below: the OTP no longer picks a session, and Vibe Together keeps no Telegram account.
  - The bridge is no participant, Luis's decision (2026-11-11): "yeah please change to this model". It reads the session without joining it, with its credential, and speaks only as the people it carries: a linked person under their account's name, anyone else as `telegram/<name>`, unverified, which only the bridge's credential may join under, Luis's agreement (2026-11-11): "okay agreed". This supersedes `<member>/messagent` and the messages from the bridge above.
    Its notices, which chat the session reaches and how many are in it, are the session's info at the account service, not entries; it marks nothing read for the people it carries, since it can't tell what they read in Telegram, ag2's proposal agreed with the model.
    An image a Telegram message sends pings `telegram` alone, the messenger's name, which is no participant's.
  - Vibe Together knows nothing of a bridge's messenger, Luis's decision (2026-11-11, Vibe Together's design): a person grants the bridge, once by OTP, to speak as their account, revocable as a token is, and messagent alone keeps which Telegram user is which account.
    The bridge is managed in the bot, Luis: "the interface is the VT telegram bot!!! … embrace that!": /start links in the private chat, and once linked offers the person's sessions as buttons, where the one pressed gets the chat; /stop ends a chat's bridge, /unlink revokes the grant.
    The account's settings show each bridge as one that speaks as the person, with Revoke, and no identities.
    This supersedes picking the session on the approval page and linking a Telegram account in Vibe Together.
  - What is built on Vibe Together is one list, as Matrix keeps it, `ecosystem.md`, each marked by what it is, Luis's decision (2026-11-10): "let's do it like matrix."
- The shared bot runs as one service of ours, on lwirth-cloud, Luis's agreement (2026-11-09): "sounds good. but we need to make sure everything is secure".
  Telegram gives a bot's updates to one receiver only, so it can't run on each person's machine; this replaces "it runs on the user's machine" for Telegram.
  Its security is designed with vibetogether-security from the start, not only reviewed before deploy.
- One messagent per messenger, each its own agent, Luis's decision:
  "most people (including me) will probably only run one messenger", and one agent managing several is "confusing and unnecessarily complicated".
  The implementation works for any messenger.
- The basic loop comes first, Luis's decision: one bot, one agent, read, send and wake, with text only.
  Voice notes come later.
- In Rust, Luis's decision.
- The agent is wakeable, not always running, Luis's decision.
  The session keeps the messages, since a session lives until everyone has left, Luis's decision, so the agent can also read them later:
  whether it answers at once or only checks now and then is the user's choice,
  which suits an agent on a laptop that is sometimes closed.
  A session also ends once nobody has received in it for a week, Luis's decision (2026-11-06), which the bridge's own receive prevents.
- Waking is solved outside Vibe Together, by impulse, Luis's decision: agentwire's blocking receive is the command an impulse waits on.
  Until impulse exists, messagent wakes the agent itself: on the bridge's own receive, an entry for the agent while the agent isn't receiving runs the wake command.
  A participant has one receive at a time, so the bridge can't wait on the agent's.
- A background process on the user's machine fetches the messages and stores them, Luis's decision:
  a bot gets no chat history, and Telegram keeps a message for it only until fetched, at most 24 hours.
  It need not always run, and may sleep with the laptop, but it must fetch each message within 24 hours.
  After it slept longer, it informs the agent that messages may have been lost, and the agent lets the user know as it sees fit, Luis's decision.
- Waking a harness stays apart from the core, Luis's decision, so the core stays harness-agnostic.
- When waking the agent fails, messagent itself puts an error message in the chat, Luis's decision, since no agent is there to tell the user.
- The text loop is tested with a bot made in BotFather, Luis's decision; onboarding through managed bots comes after.
- Only the user gets through by default, and only the user can allow other people to speak to the agent, Luis's decision.
- Whoever controls the user's messenger account controls the agent; the answer is to keep the accounts safe, and every user is made aware of it, Luis's decision.
- Messages from anyone other than the user are logged by the program, never passed to an LLM by default, since that opens the door to prompt injection, Luis's decision.
  The user may review the log with an LLM.

- One messenger chat is one conversation, Luis's decision:
  the private chat with the bot is one, and a group with the bot is a shared one of several people and agents.
- The focus is only what the messenger needs, Luis's decision.

## Open

- Groups, as built with the bridge (2026-11-10), with security's points from vt-messagent's proposal, which security passed as a design and Luis has not reviewed:
  the sender is the human `from.id` alone, never a bot, a channel or an anonymous admin; a forward is marked with its origin, and no quoted text comes in; an edit is marked and counts as its sender's message;
  the group's title is a one-line label of at most 60 characters; the session is told who reads it as the bridge starts and as the group changes;
  a group nobody bridges is left after 10 minutes; /stop by whoever added the bridge or a group admin, removing the bot, or removing the bridge in Vibe Together ends it; a migration to a supergroup moves the bridge.

- Handing over the phone, for the future, Luis's decision: the messagent puts another agent on the chat, which answers through the same bot until it hands back.

- Whether a bot is cut loose from the manager after onboarding, so that we hold no access to it.
