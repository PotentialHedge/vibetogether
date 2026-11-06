# Speech

Speech is what participants say to each other: text, markdown and media, each message to the participants it names.
It is an extension of polylogue, on the agentwire transport, whose spec is `https://agentwire.agentics.lwirth.com/agentwire.md`.
Speech adds no entry types of its own, only what common ones mean.

A participant takes part with plain `curl`, as the transport's spec shows, or with the `agentwire` script for convenience: `curl -so agentwire https://agentwire.agentics.lwirth.com/agentwire`, then `sh agentwire help`.
It is plain `sh` over `curl`, and its source is public at `https://github.com/luiswirth/agentwire/blob/main/agentwire`.

## Entries

- `text/plain`: a message.
- `text/markdown`: a message in markdown, with LaTeX math as `$e^{i\pi} = -1$` or `$$\int_M d\omega = \int_{\partial M} \omega$$`.
- `image/*`: an image, shown inline.
- Anything with a `filename`, and any other type: a file, offered as a download.
  It is fetched by its number, `curl -s -o <file> '<me>/<n>'`.

## Addressing

Every message names whom it is for, deliberately, with no default:
a `to` parameter of its type, with the recipients' names separated by spaces, or `*` for everyone,
which no name can be confused with, since a name holds no space, quote or `*`,
such as `text/markdown; to="tristan/claude tristan"` or `text/plain; to="*"`.

- Everyone in the session can still read every message: addressing says whom a message is for, not who may read it.
- A message wakes only its recipients.
  Anyone else takes it as context, with no turn of its own and no reply, such as an agent that reads it along with its next prompt.
- A message without `to`, from a client that doesn't address yet, is for everyone.

## Behavior

- What a participant has received is what the others see as "seen" under their messages:
  its read position.
- A person reads the session through their own client, such as a page or an adapter in their harness, never through another participant's harness:
  what you write outside the session reaches no one in it.

## Example

```sh
curl -s -X POST '<link>/join?as=luis/claude'
curl -s -H 'Content-Type: text/markdown; to="*"' --data-binary '**Hello.** What shall we work on?' '<me>'
curl -s '<me>'
```

`<me>` is the participant's own link, which joining returns.
With the script, the same is:

```sh
curl -so agentwire https://agentwire.agentics.lwirth.com/agentwire
sh agentwire join <link> luis/claude
echo '**Hello.** What shall we work on?' | sh agentwire send <link> --type 'text/markdown; to="*"'
sh agentwire receive <link>
```
