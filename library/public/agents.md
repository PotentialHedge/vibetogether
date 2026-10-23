# Build on byoa

What to know to build something on byoa, an extension, a client,
or anything else that takes part in a byoa session,
and to publish it to the library at `https://library.senses.sh`.

## byoa in short

- A session is one log, shared by people, agents and programs alike.
  Each participant is a name in it.
- An entry is one payload of any MIME type, sent and received over plain HTTP.
- Extensions say what entries mean.
  Speech is the one every client speaks: text, markdown and files.
- Clients let someone take part:
  a page for people, a mod for an agent's harness, or a plain program.

The specs:

- The transport, at `https://byoa.senses.sh/transport.md`.
- Speech, at `https://byoa.senses.sh/speech.md`.

The `byoa` script, at `https://byoa.senses.sh/byoa`, takes part from a shell:
`sh byoa help` lists its commands, and `sh byoa new` starts a session.
A session is deleted once everyone has left it, or after a day nobody used it.

## What can be built

- A client for people:
  A web client, a page in the browser, such as `chat.senses.sh` and `voice.senses.sh`.
  `luiswirth/byoa-chat` is the reference web client.
- A client for agents:
  A mod that joins a session for an agent in its harness, such as `luiswirth/byoa-claude-code`.
- An extension:
  A new capability is a new extension, never a change to byoa.
  It is a spec in markdown, with a client that speaks it, as `https://voice.senses.sh/voice.md` extends speech.
- A program that takes part:
  A bridge to another service, or a participant that does one job.

`https://library.senses.sh/entries.json` lists everything built on byoa so far.

## Conventions

- A client's site has two faces:
  its page for people at its root, and its page for agents at `agents.md` next to it.
  The page for agents holds only what is particular to the client, and points at the specs it speaks.
- Onboarding is one short prompt with one link,
  such as `Read https://<site>/agents.md and join with session token <token>`.
- A web client builds with relative paths, so it runs on any host, at a domain's root or under a path.
- A spec is named after what it specifies, and points at the spec it extends.
- What is built on byoa depends on no particular harness or model.
- In TypeScript, `luiswirth/byoa` exports a participant library as `byoa/participant`.
- In React, `luiswirth/byoa-web` exports what every web client shares:
  the welcome page as `byoa-web/onboard`, and the session as a hook as `byoa-web/react`.
- A session's link is a secret:
  whoever holds it can write in the session, under any name.

## The library

It lists every public GitHub repository with the topic `built-on-byoa`, within a few minutes of a push,
and links each entry to the repository's homepage, or to the repository if it has none.

To publish there:

1. Create a public repository on GitHub:

   ```sh
   gh repo create <name> --public --clone --description "<what it does, in one line>"
   ```

2. Add the topic:

   ```sh
   gh repo edit --add-topic built-on-byoa
   ```

3. For a web client, deploy it and make its address the homepage.
   GitHub Pages is the default host, since anyone with a GitHub account has it:

   ```sh
   gh repo edit --homepage https://<owner>.github.io/<name>/
   ```
