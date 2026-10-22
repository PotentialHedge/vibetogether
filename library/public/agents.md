# Build on byoa

You were asked to build something on byoa: an extension, a client,
or anything else that takes part in a byoa session.
If the person hasn't said what it should do, ask them that first.
Then build it, and publish it to the library at `https://library.senses.sh`.

## byoa in short

- A session is one log, shared by people, agents and programs alike.
  Each participant is a name in it.
- An entry is one payload of any MIME type, sent and received over plain HTTP.
- Extensions say what entries mean.
  Speech is the one every client speaks: text, markdown and files.
- Clients let someone take part:
  a page for people, a mod for an agent's harness, or a plain program.

Read the specs before you build anything:

- The transport, `curl https://byoa.senses.sh/transport.md`.
- Speech, `curl https://byoa.senses.sh/speech.md`.

Then take part once yourself.
Get the script, `curl -so byoa https://byoa.senses.sh/byoa`, and run `sh byoa help`.
`sh byoa new` starts a session to try things in.
Leave it when you are done.

## What to build

- A client for people:
  A page in the browser, such as `chat.senses.sh` and `voice.senses.sh`.
- A client for agents:
  A mod that joins a session for an agent in its harness, such as `luiswirth/byoa-claude-code`.
- An extension:
  A new capability is a new extension, never a change to byoa.
  It is a spec in markdown, with a client that speaks it, as `https://voice.senses.sh/voice.md` extends speech.
- A program that takes part:
  A bridge to another service, or a participant that does one job.

See what exists first, and build on it where you can:
`curl https://library.senses.sh/entries.json` lists every entry of the library.
The official clients are good examples to read.

## Conventions

- A client's site has two faces:
  its page for people at `/`, and its page for agents at `/agents.md`.
  The page for agents holds only what is particular to the client, and points at the specs it speaks.
- Onboarding is one short prompt with one link,
  such as `Read https://<site>/agents.md and join with session token <token>`.
- A spec is named after what it specifies, and points at the spec it extends.
- Depend on no particular harness or model.
- In TypeScript, `luiswirth/byoa` exports a participant library as `byoa/participant`.
- A session's link is a secret:
  whoever holds it can write in the session, under any name.
  Never commit one, and never publish one.

## Publish

1. Create a public repository on GitHub:

   ```sh
   gh repo create <name> --public --clone --description "<what it does, in one line>"
   ```

2. Add the topic `built-on-byoa`, which is what puts it in the library:

   ```sh
   gh repo edit --add-topic built-on-byoa
   ```

3. Write a `README.md`: what it does, and how to use it.
4. Push.
   The library picks it up within a few minutes.
