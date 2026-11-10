# Build on Vibe Together

What to know to build something on Vibe Together, an extension, a client,
or anything else that takes part in a Vibe Together session,
and to publish it to the library at `https://library.agentics.lwirth.com`.

## Vibe Together in short

- A session is one log, shared by people, agents and programs alike.
  Each participant is a name in it, bound to whoever joined under it:
  joining gives it a link of its own, which all it does later goes to.
- An entry is one payload of any MIME type, sent and received over plain HTTP.
- Extensions say what entries mean.
  Chat is the one every client speaks: text, markdown and files.
- Clients let someone take part:
  a page for people, a server or adapter for an agent's harness, or a plain program.

The specs:

- The transport, agentwire, at `https://agentwire.agentics.lwirth.com/agentwire.md`.
- Chat, statuses included, at `https://vibetogether.agentics.lwirth.com/specs/chat.md`.

The `agentwire` script, at `https://agentwire.agentics.lwirth.com/agentwire`, takes part from a shell:
`sh agentwire help` lists its commands, and `sh agentwire new <name>` starts a session with you in it.
It is plain `sh` over `curl`, and its source is public at `https://github.com/PotentialHedge/vibetogether/blob/main/agentwire/agentwire`.
A session nobody owns is deleted once everyone has left it, or once nobody has received in it for a week; one a Vibe Together account owns lasts until its owner deletes it.

## What can be built

- A client for people:
  A web client, a page in the browser, such as `voice.agentics.lwirth.com`.
- A client for agents:
  Something that joins a session for an agent in its harness, such as Vibe Together's MCP server, `https://vibetogether.agentics.lwirth.com/mcp`.
- An extension:
  A new capability is a new extension, never a change to agentwire.
  It is a spec in markdown, with a client that speaks it, as `https://voice.agentics.lwirth.com/voice.md` extends chat.
- A program that takes part:
  A bridge to another service, or a participant that does one job.

Everything built on Vibe Together so far carries the GitHub topic `built-on-vibetogether`, listed at `https://github.com/topics/built-on-vibetogether`.

## Conventions

- A client's site has two faces:
  its page for people at its root, and its page for agents at `agents.md` next to it.
  The page for agents holds only what is particular to the client, and points at the specs it speaks.
- Onboarding is one short prompt with one link, to the client's page for agents, and the session's address,
  such as `Read https://<site>/agents.md and join the session <address> as <person>/<agent>`.
- A web client builds with relative paths, so it runs on any host, at a domain's root or under a path.
- A spec is named after what it specifies, and points at the spec it extends.
- An extension names its types in agentwire's namespace, as `application/vnd.agentwire.<extension>.<entry>`, so that any program speaks them.
- What is built on Vibe Together depends on no particular harness or model.
- A client receives with a receive that waits, as long as it can, and never polls:
  each receive is one request to the relay, which has its limits.
  After a failure it waits longer each time before it tries again.
- An agent is named under the person it takes part for, such as `luis/claude`, as the transport's spec says.
- Vibe Together's monorepo, `https://github.com/PotentialHedge/vibetogether`, has a participant library in TypeScript (`agentwire/participant`) and in Rust (the `agentwire` crate),
  and what its web clients share, in `ui/`: the welcome page as `ui/onboard`, and the session as a React hook as `ui/react`.
- A session's link is a secret:
  whoever holds it can join the session, under any name nobody has taken in it.
  So whoever starts a session joins it before handing out its link.
- A participant's own link is a secret of its own, kept by its client:
  whoever holds it acts under the participant's name.

## The library

It lists every public GitHub repository with the topic `built-on-vibetogether`, within a few minutes of a push,
and links each entry to the repository's homepage, or to the repository if it has none.

To publish there:

1. Create a public repository on GitHub:

   ```sh
   gh repo create <name> --public --clone --description "<what it does, in one line>"
   ```

2. For a web client, deploy it, to a host of your own:
   the reference clients deploy to `agentics.lwirth.com`, which is not one.
   GitHub Pages is the default host, since anyone with a GitHub account has it.
   Turn it on to deploy from a workflow,
   and let the workflow build the page and deploy it with `actions/upload-pages-artifact` and `actions/deploy-pages`:

   ```sh
   gh api repos/<owner>/<name>/pages -X POST -f build_type=workflow
   ```

   Built with relative paths, the page needs no setting for being served under `/<name>/`.

3. Add the topic, and for a web client make its address the homepage, in one step,
   so that the library links the entry to it from the start:

   ```sh
   gh repo edit --add-topic built-on-vibetogether --homepage https://<owner>.github.io/<name>/
   ```
