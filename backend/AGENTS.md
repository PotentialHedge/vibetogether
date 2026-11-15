# vibetogether-backend

Vibe Together's backend: one process that serves the whole API under `/api/`, accounts and sessions alike, as `../protocol` defines it.
People sign in with GitHub; an account holds its groups with their projects and sessions, its friends with a DM each, its agents and its logins.
Vibe Together's design (`../AGENTS.md`): read it before working here.

- The API has no version in its paths, Luis's decision (2026-11-15): every answer names it in the header `vibetogether-version` (`VERSION` in `../protocol`), raised by every change that breaks an older client, and the client refuses an answer of another version with a plain error.

- axum on tokio, one SQLite database through sqlx (`src/db.rs`), with migrations in `migrations/` from the rewrite on, Luis's decision (2026-11-15).
  The pool is one connection, so queries run one after another as in one thread: whoever holds it passes it down (`&mut Db`) and never waits for it again.
- The TypeScript backend's database is imported once at start (`src/legacy.rs`): accounts and machines' tokens, as agent tokens; the rest of its state is dropped.
- A login (`src/caller.rs`, `src/auth.rs`) is a browser's sign-in, held in its cookie, or a token, `Authorization: Bearer`, of one of two kinds, Luis's decision (2026-11-15): an agent token acts only for the person's agents, naming one with `agent=<id>` in every request, account operations included, but the one creating it, so the activity records which agent did what; a person token acts as the person.
  Only the hash of a secret is stored, and every request looks its login up, so revoking one cuts it off at once.
  A token is created only by an OTP the person approves on the website (`/account/otp/`), which names its kind; OTPs wait in memory, at most ten of one address, and redeeming one waits for the person's decision, one redeem at a time, and gives the token with the name of the account that approved it.
  Signing in is GitHub's OAuth with PKCE, through the `oauth2` crate; the account is keyed by the GitHub user id.
  A change by the cookie comes from the site's origin alone, and over HTTPS every cookie is `__Host-`.
- Signing in, approving an OTP and deleting the account are the browser's alone, and accepting an invite the person's, by the browser or a person token, Luis's decision (2026-11-15); everything else a token does too.
  What a token changes is recorded for its person (`activity`), and letting someone in is limited per hour.
- The transport (`src/transport.rs`) is in memory beside the database: the log, the participants, each participant's stream and the waiting receives.
  Observing and receiving are two things, Luis's decision (2026-11-15): observing reads a session's log (`log`), with no side effects; receiving is a participant's own stream (`receive`), each item with its `reach`, and two positions, `received` and `read`, which move the participant's positions in its sessions.
  Presence is held, never declared: a waiting receive registers a guard whose destructor lets the presence go after a minute's grace, also when its connection drops.
- What waits for a change (`src/changes.rs`), such as `overview` or `log` with a `version`, wakes at every write by a login that went through, at most every 100 ms, and compares its version.
- System messages are posted from `vibetogether` by `announce`.
- `just dev` runs a local instance, and `just seed <login>` signs a person in on it, since GitHub can't call back to it.
- Served from lwirth-cloud (`~/dev/dotcloud`) through the root flake's `nixosModules.backend`, behind Caddy, which proxies `/api/` to it.
