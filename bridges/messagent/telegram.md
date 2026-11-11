# Telegram messages

messagent bridges a Telegram chat, private or a group, into a Vibe Together session, as the bot `@vt_messagent_bot` (`https://t.me/vt_messagent_bot`).
How a person sets it up: `https://vibetogether.agentics.lwirth.com/bridges/messagent/agents.md`.
Plain text, Vibe Together's chat as `text/plain` (`https://vibetogether.agentics.lwirth.com/specs/chat.md`), always reaches the chat as it is.

## Images

Images go both ways, as entries of their image type.

- A photo sent in the chat arrives as an `image/jpeg` entry, and an image sent as a file as an entry of its type, with its file name.
  Its caption follows as its sender's chat message.
  An image's payload is fetched by its number: `sh agentwire fetch <link> <n> <file>`, or `curl -s -o <file> '<me>/<n>'`.
- An image entry you send reaches the chat: a JPEG as a photo, which Telegram recompresses,
  and any other image, such as a PNG, as a file, which arrives exact, such as a page of text.

```sh
sh agentwire send <link> --type image/png plot.png
```

## Telegram's own format

Telegram's own formatting, and a caption for an image, go as an entry of their own:

- `application/vnd.agentwire.telegram.message+json`: the body of the Bot API's `sendMessage`,
  `https://core.telegram.org/bots/api#sendmessage`, passed to Telegram as is.
  messagent sets the chat.
  Its `parse_mode` is `HTML` or `MarkdownV2`, as `https://core.telegram.org/bots/api#formatting-options` describes.
- With `photo` or `document` instead of `text`, the body of `sendPhoto` or `sendDocument`,
  where `photo` or `document` is the number of the entry that holds the image, sent before it.
  Ping the bridge alone with that entry, as `ping="telegram"`, so that it doesn't reach the chat on its own too;
  the per-person bridge, which joins as `<person>/messagent`, takes `ping="<person>/messagent"`, as below.
  `caption` and `parse_mode` work as for a text.

```sh
curl -s -H 'Content-Type: application/vnd.agentwire.telegram.message+json' \
  --data-binary '{"text":"<b>Done.</b> The tests pass.","parse_mode":"HTML"}' '<me>'
curl -s -H 'Content-Type: image/png; ping="luis/messagent"' --data-binary @page.png '<me>?filename=page.png'   # {"n":12}
curl -s -H 'Content-Type: application/vnd.agentwire.telegram.message+json' \
  --data-binary '{"document":12,"caption":"<b>Today</b>","parse_mode":"HTML"}' '<me>'
```

An image or chat message that pings bridges alone never reaches a chat by itself;
a Telegram message always does, whomever it pings.
A Telegram message without a `ping` pings everyone, as a chat message does.
What doesn't ping everyone reaches a group without a notification, and what doesn't ping its person their own chat with the bot.

A message Telegram refuses, such as one whose formatting doesn't parse,
comes back as a notice from `<person>/messagent` in the per-person bridge;
the shared bot `@vt_messagent_bot` is no participant and says nothing in the session, so there it is dropped.
