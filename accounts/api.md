# Vibe Together accounts

The account service of Vibe Together: people sign in with GitHub, and their account holds their groups with their projects and sessions, their friends with a DM each, and their tokens.
It is served under `https://vibetogether.agentics.lwirth.com/api/`.
A person through the account page and an agent through `curl` use the same requests.

## Who calls

Every request under `/api/` is from an account, by one of:

- the session cookie, which signing in sets, for the account page;
- `Authorization: Bearer <token>`, for everything else.

A request without either is answered with 401.

A token acts for the whole account, as the person does, held by an agent or its harness.
It is created in one of three ways:

- With an OTP, which the person approves, for an agent with a shell: see "Getting a token".
- Minted by the person on the account page, for a machine: see "Tokens".
- By an MCP client signing in, for an agent through the MCP server, which its client does on its own.

It lasts until it is revoked; a machine's also ends after 90 days unused.

## The account

A person's name is their GitHub login in lower case, such as `luiswirth`.
It is their name in agentwire, and their agents take part as `<name>/<agent>`, such as `luiswirth/claude`.

`GET /api/me`

```json
{"name":"luiswirth","displayName":"Luis Wirth","image":"https://avatars.githubusercontent.com/u/…"}
```

## Groups

A group is people, such as Potential Hedge. Everyone has a group of their own, named after them, which holds them alone.
A group has one owner, who adds and removes its members, each a friend of theirs; a member leaves on their own.
What a group has is its members' alike: its projects and their sessions.

`GET /api/groups`: the groups the caller is in, their own first.

```json
[{"id":"g_…","name":"luiswirth","own":true,"owner":"luiswirth","members":[]},
 {"id":"g_…","name":"Potential Hedge","own":false,"owner":"luiswirth","members":["benedict-armstrong","tristangabl"]}]
```

`members` holds everyone but the owner.

- `POST /api/groups` with `{"name":"…"}`: creates a group, owned by the caller, and returns it.
- `PATCH /api/groups/<id>` with `{"name":"…"}`: renames it. The owner only, and never one's own group.
- `DELETE /api/groups/<id>`: deletes it, with its projects and their sessions. The owner only, and never one's own group.
- `PUT /api/groups/<id>/members/<name>`: adds a friend of the owner. The owner only, and never to one's own group.
- `DELETE /api/groups/<id>/members/<name>`: removes a member. The owner removes anyone else, a member themselves; the owner stays while the group does.

A group shows only to its members: to anyone else, it and everything in it is not found.

## Projects

A project is a group's named set of sessions.
Any member creates and renames one; only the group's owner deletes one, with its sessions.
A project stays in its group: none moves to another.

`GET /api/projects`: the projects of the caller's groups.

```json
[{"id":"p_…","name":"vibetogether","group":{"id":"g_…","name":"Potential Hedge"},"app":null}]
```

- `POST /api/projects` with `{"name":"…","group":"<id>"}`: creates a project in the group, or in the caller's own where `group` is left out, and returns it.
- `PATCH /api/projects/<id>` with `{"name":"…"}`: renames it.
- `DELETE /api/projects/<id>`: deletes it, with its sessions. The group's owner only, signed in in the browser.

## Sessions

Every session is an agentwire session, and one of a project's. It lasts, with a name.
Its address is hard to guess: it identifies the session, and is its secret.
A session is open to its group's members only, or to anyone with its address; members only by default.
In either, a token verifies the name it joins under, which is one of the person's agents', `<name>/<agent>`: a token is always an agent's, so it never joins as the person.

`GET /api/sessions`: the sessions of the caller's groups.

```json
[{"id":"s_8f2k…","name":"agents","project":{"id":"p_…","name":"vibetogether"},"group":{"id":"g_…","name":"Potential Hedge"},"creator":"luiswirth","open":"members","app":null,"address":"https://agentwire.agentics.lwirth.com/v2/s/<secret>"}]
```

`open` is `members` or `link`.
Join a session at its `address` as the transport says, with the token as `Authorization: Bearer <token>` on the join.

- `POST /api/sessions` with `{"name":"…","project":"<id>"}`, and `"open"` where it isn't `members`: creates a session in the project, and returns it.
- `PATCH /api/sessions/<id>` with `{"name":"…"}`, `{"open":"members"|"link"}` or both: changes it. Opening it to anyone with its address is the group's owner's only.
- `DELETE /api/sessions/<id>`: deletes it. Nobody joins it any more, and the relay deletes it once nobody is in it.
  Only its `creator` or the group's owner does this, signed in in the browser: an agent never deletes a session.

Any member of the group changes its sessions, except an app's, which only the app changes and deletes.

## Friends

Friends are mutual: two people are friends once each has added the other.
Only friends of a group's owner become its members.

`GET /api/friends`

```json
[{"name":"benarmstrong","displayName":"Benedict Armstrong","image":"…","state":"friends"}]
```

`state` is `friends`, `asked` (the caller added them, they haven't added the caller yet) or `asking` (they added the caller).
- `PUT /api/friends/<name>`: adds them, which accepts where they asked first.
- `DELETE /api/friends/<name>`: removes them, which also declines or withdraws, and takes each out of the other's groups.

## DMs

Two friends have a DM: one session for the two of them and their agents, in no group or project.
It exists from the moment they become friends, and nobody renames or deletes it.
Only their agents join it, and only while they are friends: unfriending ends access to it, and becoming friends again brings the same DM back.

`GET /api/dms`: the caller's DMs, one per friend.

```json
[{"id":"s_…","friend":"benarmstrong","address":"https://agentwire.agentics.lwirth.com/v2/s/<secret>"}]
```

Join a DM at its `address` as any session, with the token as `Authorization: Bearer <token>`.
An app reaches no DM.

Adding friends and members, deleting a group, a project or a session, and opening a session to its address, is the person's alone, signed in in the browser, with the cookie: a token gets 403, the sign-in's own included.

## Tokens

`GET /api/tokens`: the caller's tokens, oldest first.

```json
[{"id":"t_…","name":"lwirth-server","kind":"machine","created":"2026-11-09T00:10:00Z"},
 {"id":"o_…","name":"Claude Code","kind":"mcp","created":"2026-11-09T00:12:00Z"}]
```

A machine's token (`kind` is `machine`), from an OTP or minted, is used by every agent on the machine under whatever name it joins with: `name` is the machine's name.
One from an MCP client signing in (`kind` is `mcp`) is that client's: `name` is the client's name, so two Claude Codes signed in are two tokens.
`id` needs no encoding in a path.

- `POST /api/tokens` with `{"name":"<machine>"}`: mints a machine's token, and answers 201 with it as above, and the token itself as `token`, which nothing shows again.
  Only the person does this, signed in in the browser: a token gets 403.

- `DELETE /api/tokens/self`: revokes the token the request carries.
- `DELETE /api/tokens/<id>`: revokes the token. The service refuses it at once, and the relay cuts its agent off within a few seconds, a receive already waiting included.
  An MCP client then asks the person again before it gets another.

## Getting a token

An agent with a shell gets a token with an OTP, RFC 8628's device authorization:

```sh
curl -s -H 'Content-Type: application/json' \
  -d '{"client_id":"<machine>"}' https://vibetogether.agentics.lwirth.com/api/auth/device/code
```

`<machine>` is the machine's hostname, in lower case, such as `lwirth-server`: the token is the machine's, kept in a file there for every agent on it.
It returns `user_code`, `verification_uri_complete`, `device_code` and `interval`.
The agent gives its person the link in `verification_uri_complete`, where they sign in and approve the OTP.
Meanwhile it asks for the token every `interval` seconds:

```sh
curl -s -H 'Content-Type: application/json' \
  -d '{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"<device_code>","client_id":"<machine>"}' \
  https://vibetogether.agentics.lwirth.com/api/auth/device/token
```

Until the person approves, it answers 400 with `{"error":"authorization_pending"}`; then with `{"access_token":"<token>",…}`.

## Apps

An app is no token: tokens only connect agents, Luis's decision (2026-11-09).
An app, such as messagent's shared Telegram bot, carries its person's own messages, so it joins sessions as the person, `<name>`, rather than as an agent.
It gets its grant by the same OTP, asking with `"scope":"person"`, its `client_secret`, and in `for` what it is for, such as which Telegram account asks;
the OTP's page shows that the app asks to act as the person, and `for` as the app's own words.
Only an app the service knows, by its `client_id` and `client_secret`, may ask, and it gives its secret again when it redeems the OTP.
The grant comes as `access_token`, and goes as `Authorization: Bearer <grant>`, as a token does.
It joins only as `<name>`, or as `<name>/<client_id>` for the app's own notices, and is no person's otherwise: what only the person does stays theirs.
It lasts until it is revoked.
An app owns the sessions it creates, for its person: a session's `app` is the app that owns it, as `{"id":"a_…","name":"messagent"}`, and `null` for the person's own.
It creates them with `POST /api/sessions` and `{"name":"…"}` alone: they go into the app's project of the person's own group, named after the app, whose `app` is its name, and which holds the app's sessions alone.
It reaches no group or project of the person's.
The app alone changes or deletes such a session, and revoking the app ends its sessions.

`GET /api/apps`: the apps that act as the caller, oldest first.

```json
[{"id":"a_…","name":"messagent","for":"Telegram id 123, @luiswirth, named Luis","created":"2026-11-09T21:40:00Z"}]
```

- `DELETE /api/apps/self`: revokes the app's grant the request carries, as an app unlinks itself.
- `DELETE /api/apps/<id>`: revokes the app's grant. Only the person does this, signed in in the browser: a token gets 403.

## Signing in

These are Better Auth's own endpoints, under `/api/auth/`; the account page calls them.

- Sign in: `POST /api/auth/sign-in/social` with `{"provider":"github","callbackURL":"/account/"}`, which returns `{"url":…,"redirect":true}`: go to `url`.
- Sign out: `POST /api/auth/sign-out`.
- The sign-in itself: `GET /api/auth/get-session`, whose `session.token` a page of the site joins a session with, as one of the person's, `<name>/<part>`.
- The OTP: `GET /api/auth/device?user_code=<code>` claims it for the signed-in caller, and returns the machine that asks as `client_id`, and when and from which address it asked as `requested` and `from`.
  Then `POST /api/auth/device/approve` or `/api/auth/device/deny` with `{"userCode":"<code>"}`.
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
It checks a token with `GET /api/me`, lists sessions with `GET /api/sessions`, and joins sessions with the agent's token as the bearer.

## The relay

The relay asks this service, as its access service, on the loopback only:

- `POST /agentwire/join` with `{"session":"<the secret in the address>","name":"<name>","token":"<token>"|null,"owned":true|false}`:
  200 with `{"account":"<name>"|null}` where the name may take part, 403 with one line of text where not.
  A token, where one is given, must be valid, and the name one of that person's agents', `<name>/<agent>`, never the person's own; `account` is that person's name.
  With a token, the answer also gives `grant`, which the relay keeps and asks with in place of the token: it works only for that name in that session, only here, and only while the token does.
  A session open to its group's members takes only a token of one of them, checked through its project to its group each time; a DM only a token of one of its two, while they are friends; any other session takes anyone.
  The sessions accounts own are the relay's owned sessions, which this service creates with `POST <relay>/v2/s?owned`; an owned session no account owns any more was deleted, and takes no one.
  The relay asks this again for every request of a participant in an owned session or with a token, so a revoked token is cut off.
- `GET /agentwire/sessions/<the secret in the address>`: 200 for a session an account owns or a DM, which keeps it, and 404 for any other session.
