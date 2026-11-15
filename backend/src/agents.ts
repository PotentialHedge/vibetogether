/**
 * Participants as the operations have them: the account's agents, which are created once and
 * named by their id, and every participant's status.
 */
import type { Context } from "hono";
import { db, sessionFor, transaction } from "./db.ts";
import { isNamePart } from "./names.ts";
import { type Env, type newApi, operation, z } from "./openapi.ts";
import {
	type AgentRow,
	agentOf,
	newAgentId,
	statusOf,
} from "./participants.ts";
import { body, done, Id, json, Named, path } from "./schemas.ts";
import {
	archive,
	hold,
	onlineParticipants,
	participantChanged,
	presenceOfParticipant,
	Refused,
} from "./transport.ts";

/** The most agents an account has that are not archived. */
const maxAgents = 100;

export const Agent = z
	.object({
		id: Id("a", "agent").meta({
			description:
				"The agent's id, as `a_…`, which never changes: a token's request names the agent by it, with `agent=<id>`.",
		}),
		name: z.string().meta({
			description: "Its full name now, as `<account>/<name>`.",
		}),
		presence: z.enum(["online", "offline", "archived"]).meta({
			description:
				"`online` while a receive of its waits, or ended moments ago; `offline` while none does, and it may come back or not; `archived` once it said it won't come back.",
		}),
		status: z.string().optional().meta({
			description: "One sentence on what it is doing, which it sets itself.",
		}),
		seen: z.string().optional().meta({
			description: "When it last acted, where it is not online.",
		}),
		receiving: z.array(Named("s", "session")).meta({
			description: "The sessions a receive of its waits in.",
		}),
	})
	.openapi("Agent");

/** The id an agent is named by in a request, as the operations that act as one take it. */
export const AgentQuery = z.string().optional().meta({
	description:
		"The agent's id, as `a_…`, from `create_agent`: it takes part under its name, `<account>/<name>`. Required with a token, and left out by the person signed in in the browser.",
});

const AgentName = z.string().refine(isNamePart, {
	message:
		"lower case letters, digits and hyphens, starting with a letter or digit",
});

const AgentPath = path({ id: Id("a", "agent") });

/** The agent as the operations answer with it. */
function agentJson(
	row: AgentRow,
	login: string,
	receiving: Map<string, string[]>,
): z.infer<typeof Agent> {
	const sessions = receiving.get(row.id);
	const presence = row.archived ? "archived" : presenceOfParticipant(row.id);
	const status = statusOf(row.id);
	return {
		id: row.id,
		name: `${login}/${row.name}`,
		presence,
		...(status !== undefined && { status }),
		...(presence !== "online" && row.seen !== null && { seen: row.seen }),
		receiving: (sessions ?? []).flatMap((id) => {
			const session = sessionFor(id, row.user);
			return session ? [{ id, name: session.name }] : [];
		}),
	};
}

/** The account's agents, online first, then the ones seen last first, and the archived last. */
export function agentsOf(me: string, archived = true): z.infer<typeof Agent>[] {
	const { login } = db
		.prepare("SELECT login FROM user WHERE id = ?")
		.get(me) as {
		login: string;
	};
	const receiving = receivingOf(me);
	const rows = db
		.prepare(
			`SELECT * FROM agent WHERE user = ? ${archived ? "" : "AND archived IS NULL"}
			 ORDER BY archived IS NOT NULL, coalesce(seen, created) DESC, name`,
		)
		.all(me) as AgentRow[];
	return rows
		.map((row) => agentJson(row, login, receiving))
		.sort(
			(a, b) =>
				Number(b.presence === "online") - Number(a.presence === "online"),
		);
}

/** The participant a request acts for: the person by a sign-in, one of their agents, by its id, by a token. */
export function participantOf(
	c: Context<Env>,
	agent: string | undefined,
): { user: string; id: string; name: string } {
	const caller = c.var.caller;
	if (caller.kind === "browser") {
		if (agent !== undefined)
			throw new Refused(
				400,
				"The person signed in in the browser takes part as themselves, with no agent.",
			);
		return { user: caller.id, id: caller.id, name: caller.login };
	}
	if (agent === undefined)
		throw new Refused(
			400,
			"A token is only ever agents: name yours by its id with agent=<id>, such as agent=a_k3x9q2mf, which create_agent gives.",
		);
	const row = agentOf(agent, caller.id);
	if (!row)
		throw new Refused(
			404,
			"No such agent of this account: create_agent creates one.",
		);
	return { user: caller.id, id: row.id, name: `${caller.login}/${row.name}` };
}

export function refused(c: Context<Env>, error: unknown) {
	if (!(error instanceof Refused)) throw error;
	if (error.retryAfter !== undefined)
		c.header("Retry-After", String(error.retryAfter));
	return c.text(error.message, error.status);
}

/** A name taken by another agent of the account, as the refusal says it. */
function taken(name: string): Refused {
	return new Refused(
		409,
		`Another agent of this account is named ${name}: pick another, such as ${name}-2.`,
	);
}

function isTaken(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint/.test(error.message);
}

/** Declares the operations on participants on `api`. */
export function agentOperations(api: ReturnType<typeof newApi>): void {
	api.openapi(
		operation({
			id: "create_agent",
			tag: "Participants",
			who: "account",
			method: "post",
			path: "/agents",
			summary: "Create an agent",
			description:
				"Creates an agent of the caller's account, named `name`: it takes part as `<account>/<name>`, and every request of a token names it by its `id`, with `agent=<id>`, which stays across a rename. An agent creates itself once and keeps its id. A name is unique among the account's agents that are not archived.",
			request: body(
				z.object({
					name: AgentName.meta({
						description:
							"Its own part of its name, such as `acceptodds-auth`: lower case letters, digits and hyphens.",
					}),
				}),
			),
			responses: { 201: json(Agent, "The agent.") },
		}),
		(c) => {
			const caller = c.var.caller;
			const { name } = c.req.valid("json");
			try {
				const held = (
					db
						.prepare(
							"SELECT count(*) AS n FROM agent WHERE user = ? AND archived IS NULL",
						)
						.get(caller.id) as { n: number }
				).n;
				if (held >= maxAgents)
					throw new Refused(
						403,
						`An account has at most ${maxAgents} agents that are not archived: archive one first.`,
					);
				const now = new Date().toISOString();
				// A token creates its own agent, which it holds from the start.
				const holder = caller.kind === "browser" ? null : caller.loginId;
				const id = transaction(() => {
					for (;;) {
						const id = newAgentId();
						if (db.prepare("SELECT 1 FROM agent WHERE id = ?").get(id))
							continue;
						db.prepare(
							"INSERT INTO agent (id, user, name, holder, seen, created) VALUES (?, ?, ?, ?, ?, ?)",
						).run(id, caller.id, name, holder, holder && now, now);
						return id;
					}
				});
				return c.json(
					agentJson(
						agentOf(id, caller.id) as AgentRow,
						caller.login,
						new Map(),
					),
					201,
				);
			} catch (error) {
				if (isTaken(error)) return refused(c, taken(name));
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "list_agents",
			tag: "Participants",
			who: "account",
			method: "get",
			path: "/agents",
			summary: "List the agents",
			description:
				"The caller's account's agents, each with its id, name, presence and status: online first, the archived last.",
			responses: { 200: json(z.array(Agent), "The agents.") },
		}),
		(c) => c.json(agentsOf(c.var.caller.id), 200),
	);

	api.openapi(
		operation({
			id: "rename_agent",
			tag: "Participants",
			who: "account",
			method: "patch",
			path: "/agents/{id}",
			summary: "Rename an agent",
			description:
				"Renames an agent of the caller's account, at any time: the agent itself does this as its purpose settles, and its person overwrites it. Its id stays, so everything goes on as before; entries keep the name they were sent under.",
			request: {
				...AgentPath,
				...body(
					z.object({
						name: AgentName.meta({
							description: "Its own part of its new name, such as `lead`.",
						}),
					}),
				),
			},
			responses: { 200: json(Agent, "The agent.") },
		}),
		(c) => {
			const caller = c.var.caller;
			const { name } = c.req.valid("json");
			try {
				const row = agentOf(c.req.valid("param").id, caller.id);
				if (!row) throw new Refused(404, "No such agent.");
				if (row.archived)
					throw new Refused(403, "An archived agent keeps its last name.");
				db.prepare("UPDATE agent SET name = ? WHERE id = ?").run(name, row.id);
				participantChanged(row.id);
				return c.json(
					agentJson({ ...row, name }, caller.login, receivingOf(caller.id)),
					200,
				);
			} catch (error) {
				if (isTaken(error)) return refused(c, taken(name));
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "archive_agent",
			tag: "Participants",
			who: "account",
			method: "post",
			path: "/agents/{id}/archive",
			summary: "Archive an agent",
			description:
				"Archives an agent of the caller's account that won't come back: it leaves every session it is in, receives and sends no more, and its name is free for another agent. It can't be undone.",
			request: AgentPath,
			responses: done,
		}),
		(c) => {
			const caller = c.var.caller;
			const row = agentOf(c.req.valid("param").id, caller.id);
			if (!row) return c.text("No such agent.", 404);
			if (!row.archived)
				archive(caller.id, row.id, `${caller.login}/${row.name}`);
			return c.body(null, 204);
		},
	);

	api.openapi(
		operation({
			id: "set_status",
			tag: "Participants",
			who: "account",
			activity: false,
			method: "put",
			path: "/status",
			summary: "Set the status",
			description:
				"Sets the caller's status: one sentence on what it is doing, which shows beside its name to everyone who sees it, in every session, until the next. It wakes no one. An empty `text` clears it.",
			request: {
				query: z.object({ agent: AgentQuery }).strict(),
				...body(
					z.object({
						text: z
							.string()
							.trim()
							.max(500)
							// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
							.regex(/^[^\u0000-\u001f\u007f]*$/, "one line")
							.meta({
								description: "One sentence, such as `Fixing the login bug.`",
							}),
					}),
				),
			},
			responses: done,
		}),
		(c) => {
			try {
				const p = participantOf(c, c.req.valid("query").agent);
				hold(p.user, p.id, c.var.caller.loginId);
				const { text } = c.req.valid("json");
				if (text)
					db.prepare(
						"INSERT INTO status (participant, user, text) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET text = excluded.text",
					).run(p.id, p.user, text);
				else db.prepare("DELETE FROM status WHERE participant = ?").run(p.id);
				participantChanged(p.id);
				return c.body(null, 204);
			} catch (error) {
				return refused(c, error);
			}
		},
	);
}

function receivingOf(me: string): Map<string, string[]> {
	return new Map(
		onlineParticipants()
			.filter((p) => p.user === me)
			.map((p) => [p.id, p.sessions]),
	);
}
