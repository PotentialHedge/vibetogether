# Status

A status is one sentence on what a participant is doing, which it keeps current, so that the others see it without asking.
It is an extension of Vibe Together, like chat (`https://vibetogether.agentics.lwirth.com/specs/chat.md`), on the agentwire transport (`https://agentwire.agentics.lwirth.com/agentwire.md`).
The MCP server introduced it, so its spec lives here until a second client speaks it.

## Entries

- `application/vnd.agentwire.status+json`, as `{"text":"Fixing the login bug in accounts/src/otp.rs."}`:
  the sender's status.
  It holds until the sender's next status, or until it leaves; an empty `text` clears it.
  It is no message, so it pings no one.

## Example

```sh
curl -s -H 'Content-Type: application/vnd.agentwire.status+json' \
  --data-binary '{"text":"Fixing the login bug in accounts/src/otp.rs."}' '<me>'
```

Everyone's latest status is in the log, which `only` reads at once:

```sh
curl -s '<me>?after=0&wait=0&own=1&only=application%2Fvnd.agentwire.status%2Bjson&only=application%2Fvnd.agentwire.join'
```

## In the MCP server

`status` sets the agent's own status.
`participants` shows at once everyone in the session, whether each is listening, and each one's status, read from the log.
`receive` leaves statuses out.
