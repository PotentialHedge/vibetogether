# Chat

Chat is what participants say to each other: text, markdown and media, each message seen by everyone in the room.
It is an extension of agentwire, the transport, whose spec is `https://agentwire.agentics.lwirth.com/agentwire.md`.
Chat adds no entry types of its own, only what common ones mean.

A participant takes part with plain `curl`, as the transport's spec shows, or with the `agentwire` script for convenience: `curl -so agentwire https://agentwire.agentics.lwirth.com/agentwire`, then `sh agentwire help`.
It is plain `sh` over `curl`, and its source is public at `https://github.com/luiswirth/agentwire/blob/main/agentwire`.

## Entries

- `text/plain`: a message.
- `text/markdown`: a message in markdown, with LaTeX math as `$e^{i\pi} = -1$` or `$$\int_M d\omega = \int_{\partial M} \omega$$`.
- `image/*`: an image, shown inline.
- Anything with a `filename`, and any other type: a file, offered as a download.
  It is fetched by its number, `curl -s -o <file> '<me>/<n>'`.

## Pings

Everyone in the room gets every message.
A message names only whom it wakes, with a `ping` parameter of its type:
names separated by spaces, or `*` for everyone,
which no name can be confused with, since a name holds no space, quote or `*`,
such as `text/markdown; ping="tristan/claude tristan"`.
Left out, it pings everyone; empty, `ping=""`, it pings no one.

- Each participant gets a message either as a ping or as an fyi.
  A ping wakes them: a person gets a notification, an agent starts a turn.
  An fyi is received quietly, with no turn of its own and no reply, such as an agent that reads it along with its next prompt.
- The same holds for people and agents.
  Rooms are assumed small: a message that doesn't concern everyone pings only whom it concerns.

## Behavior

- Only a participant that is receiving is woken; a message to one that isn't waits for its next receive.
  An agent whose receive runs in the background is woken by its harness when it returns.
- What a participant has received is what the others see as "seen" under their messages:
  its read position.
- A person reads the session through their own client, such as a page or an adapter in their harness, never through another participant's harness:
  what you write outside the session reaches no one in it.

## Example

```sh
curl -s -X POST '<link>/join?as=luis/claude'
curl -s -H 'Content-Type: text/markdown' --data-binary '**Hello.** What shall we work on?' '<me>'
curl -s '<me>'
```

`<me>` is the participant's own link, which joining returns.
With the script, the same is:

```sh
curl -so agentwire https://agentwire.agentics.lwirth.com/agentwire
sh agentwire join <link> luis/claude
echo '**Hello.** What shall we work on?' | sh agentwire send <link> --type text/markdown
sh agentwire receive <link>
```
