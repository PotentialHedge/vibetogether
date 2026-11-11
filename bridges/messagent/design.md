# messagent

Message your agent in a messaging app, like a friend:
Vibe Together's bridge, which mirrors a messenger chat and a Vibe Together session onto each other.
Everything here is Luis's decision, except what is marked as open.
How each decision came about is in this file's Git history and in the first issue of the archived `luiswirth/messagent`.
Vibe Together's own design, which this builds on, is in the collective's `projects/vibetogether/design.md`.

## What it is

- It exists only for Vibe Together.
- The UI is the messenger: no UI of our own.
  It is managed in the messenger itself, through the Vibe Together Telegram bot, `@vt_messagent_bot`.
- It embraces how people already use each messenger, and is agnostic to which one:
  each connects with the capabilities it has.
  The capabilities are traits: `Messages`, finished content in what the messenger carries, and `Calls`, live audio both ways.
  Reacting is an optional capability of its own.
- Telegram first; Discord comes into messagent later.
  WhatsApp is not pursued for now: its setup and its rules on AI make it a hassle.
- One messenger chat, private or a group, is one bridged session.
- In Rust.

## The bridge

- One shared bot for everyone, run as one service on lwirth-cloud:
  Telegram gives a bot's updates to one receiver only.
- A bridge is no participant: it reads the session without joining, and speaks only as the people it carries.
  - A person grants the bridge once, by OTP, to speak as their account in every bridged session of their groups.
    The grant follows the OAuth device flow: the bot shows a code, and the person approves on the page that shows the same code.
    It lasts until revoked, with `/unlink` or in the account's settings.
  - Vibe Together knows nothing of the messenger: messagent alone keeps which Telegram user is which account.
  - A linked person speaks under their account name.
    Anyone else speaks as `telegram/<name>`, unverified, which only the bridge may use.
- The bot manages it: `/start` links in the private chat, and once linked, offers the person's sessions as buttons, where the one pressed gets the chat.
  `/stop` ends a chat's bridge.
- It passes everything both ways, so the bot's group privacy mode is off.
- Its notices, such as which chat the session reaches and who is in it, are the session's info at the account service, not entries.
- It marks nothing read for the people it carries, since it can't tell what they read in the messenger.
- A message the agents have read gets 👀 in the messenger.
- Images are first-class, both ways.
- The agent writes in each messenger's own format, passed through raw.
  It can react to messages, through the reactions extension.
- No typing indicator.

## The old watch

Before the bridge, messagent ran on the person's machine, with a bot of their own, and woke their agent itself.
It still runs as `messagent watch` on lwirth-server, from dothome, until Hivemind's Telegram path is on the bridge.

## Open

- Groups, as built with the bridge, with these points, which Luis has not reviewed:
  the sender is the human `from.id` alone, never a bot, a channel or an anonymous admin;
  a forward is marked with its origin, and no quoted text comes in; an edit is marked and counts as its sender's message;
  the group's title is a one-line label of at most 60 characters;
  a group nobody bridges is left after 10 minutes;
  a migration to a supergroup moves the bridge.
- Calls: Telegram bots can't call. A call would use voice's core.
- Voice notes, through voice's speech engines.
- Handing over the phone: messagent puts another agent on the chat, which answers through the same bot until it hands back.
