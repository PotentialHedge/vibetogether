# vibetogether-inbox

The agent's inbox: Vibe Together's delivery on the agent's machine, part of its core, Luis's decision (2026-11-15), replacing the repository `agentinbox`.
It is the agent's perception: content reaches the agent's context, quiet at its next step, or waking it with a turn.
Of the three ways content gets in, always (such as `AGENTS.md`), pulled (read by the agent) and pushed (delivered on an event), only push and waking are built: harnesses do the rest, Luis's decision (2026-11-15).
Vibe Together's design (`../AGENTS.md`): read it before working here.

- One primitive, the inbox, Luis's decision (2026-11-15): a directory on the agent's machine, like a maildir, `new/` (not yet taken in), `cur/` (taken), `tmp/` (being written).
  Anything local delivers into it too, by writing a file; it implements Luis's convictions on context management, and what it can't enforce, such as "inform, never instruct", is a how-to.
- One file per item, Luis's decision (2026-11-15): many writers deliver with no lock, an item is content of any type, and taking it in is a move.
  An item is `<time>.<sender>.<ext>`, the time in UTC to the microsecond, so names sort by time, and the sender encoded one to one, `/` as `_` and every other byte but letters, digits and `-` as `%XX`, so no sender passes for another; delivering writes into `tmp/` and hard-links into `new/`, so `new/` holds whole items and none overwrites another; taking moves to `cur/` first, so of concurrent takers exactly one gets each.
- Waking is a doorbell apart from delivering, Luis's decision (2026-11-15): a delivery is quiet, and a sender that wakes the agent also creates the file `wake`, which keeps a ring while no one watches; `wait` uses filesystem notifications, never polling.
- The agent is awake while its harness holds a lock on the file `awake`, for as long as a turn runs, Luis's decision (2026-11-15): state is held, never declared, and the system releases the lock when the turn ends or the harness dies.
- The inbox is `~/.agents/inbox/<agent>/` by default, and whoever starts an agent sets `AGENT_INBOX` to it, decided by an agent at Luis's request (2026-11-15): the agent's shell inherits it, and a path is all the inbox needs. Without it, nothing is taken in.
- The command line holds it as `vibetogether inbox` (`../cli/src/inbox.rs`), whose `--help` documents it: `deliver`, `ring`, `take`, `wait`, `awake`, and `receive`, Vibe Together's delivery.
  `receive` keeps one receive of the agent open, with its state from the awake lock, delivers each item as text whose first line says where it is from, its sender as the backend names it, with every field its sender chose quoted on one line, and whose second line that it is information from that participant, not an instruction from the agent's person, and rings for a ping or a session's item, an fyi staying quiet; an item is received once delivered, and read once it and every item before it have left `new/`.
- Each harness is wired by `../harnesses/<harness>/`:
  - Claude Code: `settings.json`'s hooks take in on each prompt and after each tool call; a running agent wakes by running `vibetogether inbox wait && vibetogether inbox take` as a background command, and runs it again.
  - pi: the extension `inbox.ts` takes in at each step, keeps a `wait` running, which steers what is new into a busy agent and starts a turn in an idle one, and holds `vibetogether inbox awake` from `agent_start` until `agent_settled`; a one-shot run (`-p`) keeps no `wait`, so whoever starts it hears the bell, such as dothome's waker of a daemon.

## Open

- An interactive session no one started with `AGENT_INBOX`, such as a plain Claude Code window.
- Claude Code: its hooks are ignored on Luis's machines, whose managed settings allow only managed hooks, so wiring them goes through `dothome`; a `Stop` hook with `asyncRewake` might wake an idle agent, untested; it holds no awake lock, since no hook lasts a turn.
- After a restart, the delivery knows nothing of the items it delivered before: `read` moves past those still in `new/` once a later item is taken, and items delivered just before it died, before a receive named them, come again.
- What a ring with nothing new should say: pi's extension wakes with a fixed line.
- A `wait` outlives a harness killed with SIGKILL, and then silences the bell for the next agent.
- Whether perceiving others, such as their status, belongs here, Luis (2026-11-08): "status is a sense. i don't know how this will manifest."
