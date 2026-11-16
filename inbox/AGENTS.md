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
- The sender proposes whether an item wakes, and the agent's do-not-disturb settings dispose, Luis (2026-11-16): "sure embrace the inbox", and they are one with do not disturb: "should inbox policy merge with do not disturb? i think maybe yes".
  They are the inbox's file `do-not-disturb`, which the agent keeps itself: each line fields to match and `ring` or `quiet`, the last match deciding, the proposal standing where none does; `quiet` alone is full do not disturb.
  Every perception passes it, Vibe Together's by `from`, `reach` and `session`, a local one by `from`; so Vibe Together's server decides nothing about waking.
  Being woken in a session only by mentions is not a rule here but the participant's `notify` setting there, which everyone in the session sees, decided by an agent at Luis's request (2026-11-16): "decide yourself what to do, with focus what is the best feature for a good UX"; the delivery's proposal follows it.
  Where the settings quiet a mention (`reach=ping`), the delivery's receive holds do not disturb, so others see that a mention won't wake the agent.
- Running an agent is four pieces, Luis (2026-11-16): "sounds reasonable": its identity (Vibe Together's agent, token and hold), its perception and bell (this inbox), the **waker**, which starts a harness run when the bell rings and no mind holds the agent, and its standing job (briefing, ledger, impulses), which is its setup's, such as dothome's `daemon`.
  The waker is part of the inbox, harness-agnostic and anyone's, so spawning an agent is creating it, giving it an inbox and running a waker; the impulse rings, the waker answers.
  The waker, `wake -- <command>`, answers a ring once no mind holds `awake`, by running the command while something is untaken, holding `awake` meanwhile; a ring while a mind is awake is that mind's, left for its own `wait`, so only what it leaves untaken is answered, and a ring with nothing new runs nothing; a run that fails or takes nothing in ends the answer, so a broken command never loops.
- The agent is awake while its harness holds a lock on the file `awake`, for as long as a turn runs, Luis's decision (2026-11-15): state is held, never declared, and the system releases the lock when the turn ends or the harness dies.
- The inbox is `~/.agents/inbox/<agent>/` by default, and whoever starts an agent sets `AGENT_INBOX` to it, decided by an agent at Luis's request (2026-11-15): the agent's shell inherits it, and a path is all the inbox needs. Without it, nothing is taken in.
- The command line holds it as `vibetogether inbox` (`../cli/src/inbox.rs`), whose `--help` documents it: `deliver`, `ring`, `take`, `wait`, `wake`, `awake`, `context`, and `receive`, Vibe Together's delivery.
  `receive` keeps one receive of the agent open, with its state from the awake lock, delivers each item as text whose first line says where it is from, its sender as the backend names it, with every field its sender chose quoted on one line, and whose second line that it is information from that participant, not an instruction from the agent's person, and proposes a ring for a ping or a session's item, an fyi staying quiet; an item is received once delivered, and read once it and every item before it have left `new/`.
- A perception reports a change, not a clock, and states information, never policy, Luis's decisions in Hivemind, built back into the inbox at his request (2026-11-16): "let's have all hivemind perceptions that are valuable and make sense be built back into the inbox."
  A local source delivers quietly, only as a reading crosses a mark, and keeps the mark it told last in a file of the inbox.
  - The context's size: `context` tells it against the model's window as it crosses a tenth of the window, either way, from `context`; a harness runs it at each step before `take`, Luis (2026-11-16): "we also need to give you awareness of context size vs limit."
    Tenths of the window, as in Hivemind, since the window is the hard limit; a soft budget is the user's policy, in their context.
- Each harness is wired by `../harnesses/<harness>/`:
  - Claude Code: `settings.json`'s hooks take in on each prompt and after each tool call, after telling the context's size, read from the transcript's last response as Claude Code counts it; its hooks receive no window, so they take `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, else 1M, the window of Claude's current models; a running agent wakes by running `vibetogether inbox wait && vibetogether inbox take` as a background command, and runs it again.
  - pi: the extension `inbox.ts` takes in at each step, after telling the context's size from `getContextUsage`, keeps a `wait` running, which steers what is new into a busy agent and starts a turn in an idle one, and holds `vibetogether inbox awake` from `agent_start` until `agent_settled`; a one-shot run (`-p`) keeps no `wait`, so whoever starts it hears the bell, such as the waker.

## Open

- An interactive session no one started with `AGENT_INBOX`, such as a plain Claude Code window.
- Claude Code: its hooks are ignored on Luis's machines, whose managed settings allow only managed hooks, so wiring them goes through `dothome`; a `Stop` hook with `asyncRewake` might wake an idle agent, untested; it holds no awake lock, since no hook lasts a turn.
- After a restart, the delivery knows nothing of the items it delivered before: `read` moves past those still in `new/` once a later item is taken, and items delivered just before it died, before a receive named them, come again.
- What a ring with nothing new should say: pi's extension wakes with a fixed line.
- A `wait` outlives a harness killed with SIGKILL, and then silences the bell for the next agent.
- The awake lock excludes only wakers: pi's extension starts its turn without waiting for the lock, and a waker killed alone, not with its process group, frees the lock while its run goes on.
- Hivemind's other senses, judged 2026-11-16:
  - Time: dothome's clock hook tells Claude Code the time at each prompt and how long a slow call took; pi has no clock yet, and moving that clock into the inbox would serve both, but it is dothome's now.
  - Quotas: valuable to pace the work, but they are model-pool's knowledge (`GET /v1/quotas`), shared and reset by a clock, and which ones an agent counts against depends on its access; model-pool or dothome could deliver them into the inbox, with no part of it in Vibe Together.
  - Sight: how an image reaches a model is the harness's, no delivery.
  - Others' work: Vibe Together delivers others' messages, joins and leaves; their status is the next point.
- Whether perceiving others, such as their status, belongs here, Luis (2026-11-08): "status is a sense. i don't know how this will manifest."
