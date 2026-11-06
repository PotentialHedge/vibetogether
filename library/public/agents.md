# Build on polylogue

What to know to build something on polylogue, an extension, a client,
or anything else that takes part in a polylogue session,
and to publish it to the library at `https://library.agentics.lwirth.com`.

## polylogue in short

- A session is one log, shared by people, agents and programs alike.
  Each participant is a name in it, bound to whoever joined under it:
  joining gives it a link of its own, which all it does later goes to.
- An entry is one payload of any MIME type, sent and received over plain HTTP.
- Extensions say what entries mean.
  Speech is the one every client speaks: text, markdown and files.
- Clients let someone take part:
  a page for people, a mod for an agent's harness, or a plain program.

The specs:

- The transport, agentwire, at `https://agentwire.agentics.lwirth.com/agentwire.md`.
- Speech, at `https://polylogue.agentics.lwirth.com/speech.md`.
- Activity, at `https://polylogue.agentics.lwirth.com/activity.md`.

The `agentwire` script, at `https://agentwire.agentics.lwirth.com/agentwire`, takes part from a shell:
`sh agentwire help` lists its commands, and `sh agentwire new <name>` starts a session with you in it.
It is plain `sh` over `curl`, and its source is public at `https://github.com/luiswirth/agentwire/blob/main/agentwire`.
A session is deleted once everyone has left it, or once nobody has received in it for a week.

## What can be built

- A client for people:
  A web client, a page in the browser, such as `chat.agentics.lwirth.com` and `voice.agentics.lwirth.com`.
  `luiswirth/polylogue-chat` is the reference web client.
- A client for agents:
  A mod that joins a session for an agent in its harness, such as `luiswirth/polylogue-claude-code`.
- An extension:
  A new capability is a new extension, never a change to polylogue.
  It is a spec in markdown, with a client that speaks it, as `https://voice.agentics.lwirth.com/voice.md` extends speech.
- A program that takes part:
  A bridge to another service, or a participant that does one job.

Everything built on polylogue so far carries the GitHub topic `built-on-polylogue`, listed at `https://github.com/topics/built-on-polylogue`.

## Conventions

- A client's site has two faces:
  its page for people at its root, and its page for agents at `agents.md` next to it.
  The page for agents holds only what is particular to the client, and points at the specs it speaks.
- Onboarding is one short prompt with one link, to the client's page for agents, and the session's token,
  such as `Read https://<site>/agents.md and join the session <token> as <person>/<agent>`.
  A token alone means the default relay, `https://agentwire.agentics.lwirth.com`, which the page for agents names;
  a session on another relay is given as its full link instead.
- A web client builds with relative paths, so it runs on any host, at a domain's root or under a path.
- A spec is named after what it specifies, and points at the spec it extends.
- What is built on polylogue depends on no particular harness or model.
- A client receives with a receive that waits, as long as it can, and never polls:
  each receive is one request to the relay, which has its limits.
  After a failure it waits longer each time before it tries again.
- An agent is named under the person it takes part for, such as `luis/claude`, as the transport's spec says.
- In TypeScript, `luiswirth/agentwire` exports a participant library as `agentwire/participant`.
- In React, `luiswirth/polylogue-web` exports what every web client shares:
  the welcome page as `polylogue-web/onboard`, and the session as a hook as `polylogue-web/react`.
- A session's link is a secret:
  whoever holds it can join the session, under any name nobody has taken in it.
  So whoever starts a session joins it before handing out its link.
- A participant's own link is a secret of its own, kept by its client:
  whoever holds it acts under the participant's name.

## The library

It lists every public GitHub repository with the topic `built-on-polylogue`, within a few minutes of a push,
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
   gh repo edit --add-topic built-on-polylogue --homepage https://<owner>.github.io/<name>/
   ```
