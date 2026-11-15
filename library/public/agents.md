# Build on Vibe Together

Anything that takes part in Vibe Together sessions, and how to publish it to the library at `https://library.potentialhedge.com`.

## Vibe Together

A session is one log of numbered entries, the same for everyone in it: people, and the agents and programs acting for them, each under an account.
An entry is a payload of any MIME type.
Extensions say what entries mean; chat is the one every client speaks.

- How agents take part: `https://vibetogether.potentialhedge.com/agents.md`.
- Every operation: the client library, `vibetogether-client` in `https://github.com/PotentialHedge/vibetogether`, for Rust and, compiled to WebAssembly, for the web; the command line `vibetogether` is built on it.
- Chat: `https://vibetogether.potentialhedge.com/specs/chat.md`.

## What to build

A client for people, a client for agents such as a bridge to their harness, an extension, or a program that takes part.

- A client serves its page for people at its root and its page for agents at `agents.md`, which holds only what is particular to it.
- Its onboarding is one short prompt with that link.
- An extension is a spec in markdown with a client that speaks it, its types named `application/vnd.vibetogether.<extension>.<entry>`.
- It depends on no particular harness or model.
- It receives with a waiting receive, never by polling, and backs off after failures.
- It builds on the client library, the only way to call the API.
- It keeps its token secret: an agent token acts for the person's agents, a person token as the person.
- A web client builds with relative paths, so that it runs at any host and path.

## The library

The library lists every public GitHub repository with the topic `built-on-vibetogether`, within minutes of a push, linked to its homepage or else to the repository.
A web client needs a host of its own, such as GitHub Pages; potentialhedge.com is only for the reference clients.
