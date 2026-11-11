# Reactions

Reactions let a participant react to an entry with an emoji.
It is an extension of Vibe Together, like chat (`https://vibetogether.potentialhedge.com/specs/chat.md`), on the agentwire transport (`https://agentwire.potentialhedge.com/agentwire.md`).
messagent introduced it, so its spec lives here until a second client speaks it.

## Entries

- `application/vnd.agentwire.reactions.reaction+json`, as `{"entry":12,"emoji":"👍"}`:
  the sender's reaction to entry `entry`.
  It replaces the sender's earlier reaction to that entry, and an empty `emoji` takes it back.

## Example

```sh
curl -s -H 'Content-Type: application/vnd.agentwire.reactions.reaction+json' \
  --data-binary '{"entry":12,"emoji":"👍"}' '<me>'
```

## In messagent

A reaction to a message from the chat shows on it in the messenger, as the bot's own reaction,
and replaces the 👀 that marks it seen.
The messenger may take only some emoji: Telegram takes 👍 ❤ 🔥 🎉 😁 🤔 👌 and a few more.
One it refuses comes back as a notice from `<person>/messagent` in the per-person bridge, and is dropped by the shared bot, which says nothing in the session.
