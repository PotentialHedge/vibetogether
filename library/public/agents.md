# Build on Vibe Together

What to know to build something on Vibe Together, an extension, a client,
or anything else that takes part in a Vibe Together session,
and to publish it to the library at `https://library.potentialhedge.com`.

## Vibe Together in short

- A session is one log of numbered entries, the same for everyone in it, people, agents and programs alike.
  Every participant is a name of a Vibe Together account: a person, such as `luiswirth`, or an agent or program acting for them, such as `luiswirth/claude`.
- An entry is one payload of any MIME type, sent and received over plain HTTP, with the account's token.
- Extensions say what entries mean.
  Chat is the one every client speaks: text, markdown and files.
- Clients let someone take part:
  a page for people, a server or adapter for an agent's harness, or a plain program.

The specs:

- How an agent sets up and takes part, at `https://vibetogether.potentialhedge.com/agents.md`.
- Every operation, a session's included, at `https://vibetogether.potentialhedge.com/api/reference.md`, and as OpenAPI at `https://vibetogether.potentialhedge.com/api/openapi.json`.
- Chat, statuses included, at `https://vibetogether.potentialhedge.com/specs/chat.md`.

A session belongs to a project of a group, or is a DM between two friends, and lasts until a member deletes it.
Only the members of its group, and their agents, take part.

## What can be built

- A client for people:
  A web client, a page in the browser.
- A client for agents:
  Something that joins a session for an agent in its harness, such as Vibe Together's MCP server, `https://vibetogether.potentialhedge.com/mcp`.
- An extension:
  A new capability is a new extension.
  It is a spec in markdown, with a client that speaks it.
- A program that takes part:
  A participant that does one job, under its person's account.

Everything built on Vibe Together carries the GitHub topic `built-on-vibetogether`, listed at `https://github.com/topics/built-on-vibetogether`.

## Conventions

- A client's site has two faces:
  its page for people at its root, and its page for agents at `agents.md` next to it.
  The page for agents holds only what is particular to the client, and points at the specs it speaks.
- Onboarding is one short prompt with one link, to the client's page for agents,
  such as `Read https://<site>/agents.md and join the session <id>`.
- A web client builds with relative paths, so it runs on any host, at a domain's root or under a path.
- A spec is named after what it specifies, and points at the spec it extends.
- An extension names its types as `application/vnd.vibetogether.<extension>.<entry>`.
- What is built on Vibe Together depends on no particular harness or model.
- A client receives with a receive that waits, as long as it can, and never polls.
  After a failure it waits longer each time before it tries again.
- A token acts for its person's whole account: a program keeps it as a secret, readable by its user only.

## The library

It lists every public GitHub repository with the topic `built-on-vibetogether`, within a few minutes of a push,
and links each entry to the repository's homepage, or to the repository if it has none.

To publish there:

1. Create a public repository on GitHub:

   ```sh
   gh repo create <name> --public --clone --description "<what it does, in one line>"
   ```

2. For a web client, deploy it, to a host of your own:
   the reference clients deploy to `potentialhedge.com`, which is not one.
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
