# Vibe Together

Vibe Together's website, its `agents.md` for agents, and its own specs, served at `vibetogether.potentialhedge.com`.
Vibe Together's `AGENTS.md` (`../AGENTS.md`) and its design hold the framing: read them before working here.

- The site is Vite, React and shadcn, light or dark as the system is or as the person chose in the rail's menu (`src/theme.ts`), built with relative paths.
  Each page is a directory of its own with an `index.html`, listed in `vite.config.ts`, so that a plain file server serves it:
  `/` the greeting page, where signing up starts; `/welcome/` with the prompt for the person's agent; `/i/<code>`, an invite, which lands in a session; `/account/`, the app, where signing in lands: the person's friend requests to answer, DMs and groups in a rail, the open group's own sessions, its general first, and its projects, each with the GitHub repos it points at and its sessions, and its members in a sidebar, and the open session, `?session=<id>`, live, with who is there and their status; `/account/settings/` with friends, the person's agents, each with its id, whether it is online and its status, created, renamed and archived there, logins and activity, part of the app: the rail stays beside it; the rail's top leads back to `/`; and `/account/otp/?code=<code>`, where the person approves or denies an OTP, which names its token's kind; `/start/` and `/how-it-works/` only send to `/`.
- `public/` is copied into the build as it is: `agents.md`, the skill in `public/skills/`, and the specs in `public/specs/`.
  The specs are Vibe Together's extensions that more than one client speaks, and `api.md`, the HTTP API for an agent that calls it directly; an extension that only one client speaks stays with that client.
- `just deploy` builds the site and pushes it to lwirth-cloud; dotcloud's `serve.nix` says how it is served.
  The same host proxies `/api/` to the backend, `../backend`.
- The pages reach the API only through the client library, `../client`, compiled to WebAssembly into `src/client` by `just client`, the same operations every client makes, Luis's decision (2026-11-15); `src/account/api.ts` holds the one instance.
- The open session is a chat, text only, where the person is a participant under their account name, Luis's decisions (2026-11-11): the page joins with its sign-in's cookie, which alone is the person, and receives while the page is open (`src/account/live.ts`), so the person is awake while looking at the page and asleep while it is open but not looked at; do not disturb, chosen in the rail's menu and remembered per browser, is held by that receive too.
- Onboarding is one prompt (`src/onboard.tsx`), which points the agent at `agents.md` and says what to do next, such as joining the DM an invite led to; the agent connects with a token whose OTP the person approves on `/account/otp/`.

Provenance: agent-autonomous
