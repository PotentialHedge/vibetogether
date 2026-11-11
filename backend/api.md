# Vibe Together's API

The backend's API, served under `https://vibetogether.potentialhedge.com/api/`.
A person through the website and an agent through `curl` or the MCP server use the same requests.

## Operations

Every operation is defined once, in the code, with its arguments, answers and description for agents.
The backend checks each request against it, and serves the definitions as an OpenAPI document at `/api/openapi.json`, and rendered as the reference agents read at `/api/reference.md`.
The MCP server makes its tools from the same document, so both say the same.
This file holds what is no operation of the backend's own.

## Who calls

Every request under `/api/` is from an account, by one of its logins:

- the cookie, which signing in sets, for the website, which is the person;
- `Authorization: Bearer <token>`, for everything else, which is only ever agents: a request in a session names its agent with `agent=<name>`.

A request without either is answered with 401.

A token acts for the whole account, as the person does, Luis's decision (2026-11-10): only deleting the account, signing in and approving an OTP stay the person's, in the browser.
It is created only by signing in: an OTP the person approves, for a machine, or OAuth, for an MCP client.
What a token changes on the account is recorded for the person (`/api/activity`).
It lasts until it is revoked (`revoke_login`).

## Signing in

These are Better Auth's own endpoints, under `/api/auth/`.

- Sign in: `POST /api/auth/sign-in/social` with `{"provider":"github","callbackURL":"/account/"}`, which returns `{"url":…,"redirect":true}`: go to `url`.
- Sign out: `POST /api/auth/sign-out`.
- An agent's token, by OTP (RFC 8628):
  - The agent: `POST /api/auth/device/code` with `{"client_id":"<machine>"}`, which returns `device_code`, `user_code`, `verification_uri_complete` and `interval`.
    Then, every `interval` seconds, `POST /api/auth/device/token` with `{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"…","client_id":"<machine>"}`, until it returns `access_token`.
  - The person, on `/account/device/?user_code=<code>`: `GET /api/auth/device?user_code=<code>` claims it, and returns the machine as `client_id`, and when and from which address it asked as `requested` and `from`.
    Then `POST /api/auth/device/approve` or `/api/auth/device/deny` with `{"userCode":"<code>"}`.
- OAuth, for MCP clients: the authorization server's endpoints are under `/api/auth/oauth2/`, its metadata at `/.well-known/oauth-authorization-server/api/auth`.
  It sends the person to two pages, each with a signed query, which the page passes on whole as `oauth_query` (the query string without its `?`):
  - `/account/sign-in/?…`: `POST /api/auth/sign-in/social` with `{"provider":"github","callbackURL":"/account/","oauth_query":"…"}`, then go to `url`. After GitHub, Better Auth goes on with the authorization by itself.
  - `/account/consent/?…`, whose query names the asking client as `client_id` and the scopes as `scope`. `GET /api/auth/oauth2/public-client?client_id=<id>` gives its `client_name`.
    `POST /api/auth/oauth2/consent` with `{"accept":true|false,"oauth_query":"…"}` returns `{"redirect":true,"url":…}`: go to `url`.

A request with a token reaches only the endpoints an agent or MCP client needs, the device and OAuth token endpoints; every other one is the person's, in the browser.

## The MCP server

The MCP server is the protected resource `https://vibetogether.potentialhedge.com/mcp`.
Its metadata, per RFC 9728, is at `/.well-known/oauth-protected-resource/mcp`.
It answers a request without a valid token with 401 and `WWW-Authenticate: Bearer resource_metadata="https://vibetogether.potentialhedge.com/.well-known/oauth-protected-resource/mcp"`, so the client signs in as it connects.
Each operation a token may call is a tool, called as the same request with the agent's token.
