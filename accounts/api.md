# Vibe Together accounts

The account service of Vibe Together: people sign in with GitHub, and their account holds their groups with their projects and sessions, their friends with a DM each, and their tokens.
It is served under `https://vibetogether.agentics.lwirth.com/api/`.
A person through the website and an agent through `curl` or the MCP server use the same requests.

## Operations

Every operation is defined once, in the code (`src/api.ts`), with its arguments, answers and description for agents.
The service checks each request against it, and serves the definitions as an OpenAPI document at `/api/openapi.json`, and rendered as the reference agents read at `/api/reference.md`.
The MCP server makes its account tools from the same document, so both say the same.
This file holds what is no operation of the service's own.

## Who calls

Every request under `/api/` is from an account, by one of:

- the session cookie, which signing in sets, for the website;
- `Authorization: Bearer <token>`, for everything else.

A request without either is answered with 401.

A token acts for the whole account, as the person does, held by an agent or its harness, Luis's decision (2026-11-10): only deleting the account, signing in and approving an OTP stay the person's, in the browser.
It is created with an OTP, which the person approves, by an MCP client signing in, or minted by the person or an agent; a token goes with the token that minted it.
What a token changes is recorded for the person (`/api/activity`), and adding friends and members and minting tokens are limited per hour.
It lasts until it is revoked; a machine's also ends after 90 days unused.

## Bridges

A bridge mirrors a room outside Vibe Together and a session onto each other, such as messagent for a Telegram chat, Luis's decisions (2026-11-10): it owns no session, and is added to one, as a client joins one.
Its credential is no token: tokens only connect agents.
It asks for an OTP with `"scope":"bridge"`, its `client_secret`, and in `for` what it bridges, in its own words;
where the chat is one person's alone, such as a private chat with a bot, also with `identity`, the sender's id on its messenger, and `identity_name`.
Only a bridge the service knows, by its `client_id` and `client_secret` (the module's `bridgesFile`), may ask, and it gives its secret again when it redeems the OTP.
The OTP's page shows `bridge: true`, `for`, and `identity` as the identity's name; approving it takes `"session":"<id>"`, a session of the approver's groups, once per bridge, person and session, at most 20 per person.
Approving one with an identity links that identity to the approver, from whoever had it before.

The credential comes as `access_token`, and goes as `Authorization: Bearer <credential>`.
It reads only that session, while its approver is in the session's group, and is no participant there: it joins only as the people it carries, Luis's decision (2026-11-11).
Each is a member of the group who linked an identity on that bridge, under their own name, or anyone else it carries, under its messenger's name, such as `telegram/<name>`, unverified.
No other caller joins under a bridge's messenger's name, so that no account passes as a person a bridge carries.
A bridge's messenger is the third field of its line in `bridgesFile`, `<client_id> <sha256 of the secret> <messenger>`.
What it says of its room, such as a Telegram group and how many are in it, is the session's info, set with `PATCH /api/bridges/self` and shown in the session's `bridges`, not an entry.
It reaches no operation but those on itself, `/api/bridges/self`.
It lasts until the session is deleted, its approver leaves the group, a member removes it, or it removes itself.

## Signing in

These are Better Auth's own endpoints, under `/api/auth/`; the account page calls them.

- Sign in: `POST /api/auth/sign-in/social` with `{"provider":"github","callbackURL":"/account/"}`, which returns `{"url":…,"redirect":true}`: go to `url`.
- Sign out: `POST /api/auth/sign-out`.
- The sign-in itself: `GET /api/auth/get-session`, whose `session.token` a page of the site joins a session with, as one of the person's, `<name>/<part>`.
- The OTP: `GET /api/auth/device?user_code=<code>` claims it for the signed-in caller, and returns the machine or bridge that asks as `client_id`, and when and from which address it asked as `requested` and `from`.
  Then `POST /api/auth/device/approve` or `/api/auth/device/deny` with `{"userCode":"<code>"}`, and for a bridge's `"session":"<id>"` too.
  The page is `/account/device/?user_code=<code>`.
- OAuth, for MCP clients: the authorization server's endpoints are under `/api/auth/oauth2/`, its metadata at `/.well-known/oauth-authorization-server/api/auth`.
  It sends the person to two pages, each with a signed query, which the page passes on whole as `oauth_query` (the query string without its `?`):
  - `/account/sign-in/?…`: `POST /api/auth/sign-in/social` with `{"provider":"github","callbackURL":"/account/","oauth_query":"…"}`, then go to `url`. After GitHub, Better Auth goes on with the authorization by itself.
  - `/account/consent/?…`, whose query names the asking client as `client_id` and the scopes as `scope`. `GET /api/auth/oauth2/public-client?client_id=<id>` gives its `client_name`.
    `POST /api/auth/oauth2/consent` with `{"accept":true|false,"oauth_query":"…"}` returns `{"redirect":true,"url":…}`: go to `url`.

## The MCP server

The MCP server is the protected resource `https://vibetogether.agentics.lwirth.com/mcp`.
Its metadata, per RFC 9728, is served by this service at `/.well-known/oauth-protected-resource/mcp`.
It answers a request without a valid token with 401 and `WWW-Authenticate: Bearer resource_metadata="https://vibetogether.agentics.lwirth.com/.well-known/oauth-protected-resource/mcp"`.
It checks a token with `GET /api/me`, reads the operations from `GET /api/openapi.json` and offers each one a token may call as a tool, and calls them and joins sessions with the agent's token as the bearer.

## The relay

The relay asks this service, as its access service, on the loopback only:

- `POST /agentwire/join` with `{"session":"<the secret in the address>","name":"<name>","token":"<token>"|null,"owned":true|false}`:
  200 with `{"account":"<name>"|null}` where the name may take part, 403 with one line of text where not.
  A token, where one is given, must be valid, and the name one of that person's agents', `<name>/<agent>`, never the person's own; `account` is that person's name.
  A bridge's credential joins as Bridges says, and `account` is the name it joins as where that is a person, else `null`.
  A name under a bridge's messenger's, such as `telegram/<name>`, takes that bridge's credential alone.
  For a session accounts own, the answer also gives `about`, `{"project":"<name>","repos":[…]}`, which the relay passes on in its join answer, so the participant learns its project's repositories.
  With a token, the answer also gives `grant`, which the relay keeps and asks with in place of the token: it works only for that name in that session, only here, and only while the token does.
  A session accounts own takes only a token of one of its group's members, checked through its project to its group each time; a DM only a token of one of its two, while they are friends; a session no account owns, which is the relay's alone, takes anyone.
  The sessions accounts own are the relay's owned sessions, which this service creates with `POST <relay>/v2/s?owned`; an owned session no account owns any more was deleted, and takes no one.
  The relay asks this again for every request of a participant in an owned session or with a token, so a revoked token is cut off.
- `POST /agentwire/read` with `{"session":"<the secret in the address>","token":"<token>"|null,"owned":true|false}`, for reading a session without joining it:
  200 with `{"account":"<name>"|null}` for whoever may join it, by the same checks, and 403 with one line of text for anyone else.
- `GET /agentwire/sessions/<the secret in the address>`: 200 for a session an account owns or a DM, which keeps it, and 404 for any other session.
