# vibetogether-mcp

The MCP server through which an agent joins a session and acts on its person's account, made from the backend's OpenAPI document.
Read Vibe Together's design (`../AGENTS.md`) before working here.

- A generic layer (`src/mcp.ts`): each operation a token may call is a tool of its id, with its description and arguments, called as the same request with the agent's token, and the document's concepts go into the instructions.
  Nothing here knows any operation: the document is the one definition of each, Luis's decision (2026-11-10).
  An operation whose body is the payload itself, such as `send`, takes it as `content`, with `type` and `base64`.
- Answers reach the agent as text, an image as MCP image content up to 5 MB, anything else as how to fetch it.
- The backend mounts it at `/mcp` and calls the operations in its own process, with no second service.
  Streamable HTTP, so adding it to a harness is one URL; without a valid token it answers MCP's 401 challenge, so the client signs in as it connects.
- `receive` blocks until it returns, as the backend's receive does.
- `just ci` runs its own checks; the backend's tests use it through HTTP.
- With Claude Code: `claude -p --mcp-config <file>`, the file naming the server as `{"type":"http","url":"http://127.0.0.1:8793/mcp"}`, against `just backend::dev`.

Provenance: agent-autonomous
