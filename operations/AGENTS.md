# vibetogether-operations

The operations of an OpenAPI document as they are called: each with its arguments in one schema, its references resolved, and where each argument goes, a path or query parameter, a JSON body field, or the payload itself as `content`.
Read Vibe Together's design (`../AGENTS.md`) before working here.

- The MCP server (`../mcp`) and the command line (`../cli`) both stand on it, and neither duplicates it.
- It knows no operation and no client: which operations a client offers, such as MCP's `x-tool`, is the client's.
- It depends on nothing, so the command line stays free of the MCP SDK.
- Its behavior is tested through its clients' tests.
