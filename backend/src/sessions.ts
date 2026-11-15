/**
 * Sessions: a project's sessions as the account has them, and each session's log, which its
 * participants join, send to, receive from and leave (`transport.ts`).
 */
import type { Context } from "hono";
import { AgentQuery, participantOf, refused } from "./agents.ts";
import {
	db,
	generalOf,
	isMember,
	newId,
	type SessionAccess,
	sessionFor,
	transaction,
} from "./db.ts";
import { type Env, type newApi, operation, z } from "./openapi.ts";
import { reposOf } from "./repos.ts";
import { body, count, done, Id, json, Login, Name, path } from "./schemas.ts";
import {
	announce,
	join,
	leave,
	maxPayload,
	observe,
	type Participant,
	payloadOf,
	presenceOf,
	quoted,
	Refused,
	receive,
	send,
} from "./transport.ts";

/** The most sessions one project holds, and one group of its own, besides its general. */
const maxSessions = 20;

export const Session = z
	.object({
		id: Id("s", "session"),
		name: z.string(),
		project: z
			.object({
				id: Id("p", "project"),
				name: z.string(),
				repos: z.array(z.string()).meta({
					description:
						"The GitHub repositories the project points at, where its work lives.",
				}),
			})
			.nullable()
			.meta({
				description:
					"The project it belongs to; null for a DM and for a group's own session.",
			}),
		group: z
			.object({ id: Id("g", "group"), name: z.string() })
			.nullable()
			.meta({
				description: "The group whose members take part; null for a DM.",
			}),
		pinged: z.boolean().meta({
			description:
				"Whether a message in it pinged the caller's person, which they haven't read yet.",
		}),
		general: z.boolean().meta({
			description:
				"Whether it is its group's `general`, which every group has, for what is about no one project. The general of one's own group is one's inbox from Vibe Together.",
		}),
		friend: Login.nullable().meta({
			description: "For a DM, the other person in it; null otherwise.",
		}),
		creator: Login.nullable(),
	})
	.openapi("Session");

type SessionRow = {
	id: string;
	name: string;
	project: string | null;
	projectName: string | null;
	groupId: string | null;
	groupName: string | null;
	general: number | null;
	creatorLogin: string | null;
	a: string | null;
	b: string | null;
};

const sessions = `SELECT s.id, s.name, s.project, p.name AS projectName, g.id AS groupId,
	g.name AS groupName, gs.general, c.login AS creatorLogin, d.a, d.b
	FROM session s LEFT JOIN project p ON p.id = s.project
	LEFT JOIN group_session gs ON gs.session = s.id
	LEFT JOIN "group" g ON g.id = coalesce(p."group", gs."group")
	LEFT JOIN user c ON c.id = s.creator LEFT JOIN dm d ON d.session = s.id`;

/** A session as `me` sees it, as the operations answer with it. */
export function sessionJson(id: string, me: string): z.infer<typeof Session> {
	const row = db.prepare(`${sessions} WHERE s.id = ?`).get(id) as SessionRow;
	const other = row.a === me ? row.b : row.a;
	const friend = other
		? (
				db.prepare("SELECT login FROM user WHERE id = ?").get(other) as {
					login: string;
				}
			).login
		: null;
	return {
		id: row.id,
		name: row.name,
		project:
			row.project && row.projectName
				? {
						id: row.project,
						name: row.projectName,
						repos: reposOf(row.project),
					}
				: null,
		group:
			row.groupId && row.groupName
				? { id: row.groupId, name: row.groupName }
				: null,
		general: row.general === 1,
		// The person's stream holds its unread items alone.
		pinged:
			db
				.prepare(
					"SELECT 1 FROM stream WHERE participant = ? AND session = ? AND reach = 'ping'",
				)
				.get(me, id) !== undefined,
		friend,
		creator: row.creatorLogin,
	};
}

/** The sessions of `me`'s groups, each group's general first, then oldest first. */
export function sessionsOf(me: string): string[] {
	return (
		db
			.prepare(
				`SELECT s.id FROM session s LEFT JOIN project p ON p.id = s.project
				 LEFT JOIN group_session gs ON gs.session = s.id
				 JOIN group_member m ON m."group" = coalesce(p."group", gs."group")
				 WHERE m.user = ? ORDER BY coalesce(gs.general, 0) DESC, s.created`,
			)
			.all(me) as { id: string }[]
	).map((s) => s.id);
}

/** The session of a group where `me` is in it: a DM is no group's, so none of these. */
function groupSessionFor(id: string, me: string): SessionAccess | undefined {
	const session = sessionFor(id, me);
	return session?.group ? session : undefined;
}

/** Where a session is, for a system message: " in the project **x**", or nothing for a group's own. */
function whereOf(session: SessionAccess): string {
	if (!session.project) return "";
	const project = db
		.prepare("SELECT name FROM project WHERE id = ?")
		.get(session.project) as { name: string };
	return ` in the project ${quoted(project.name)}`;
}

const SessionPath = path({ id: Id("s", "session") });

const Entry = z
	.object({
		n: z.number().meta({ description: "Its number in the log, from 1." }),
		time: z.string().meta({ description: "When it was appended, in UTC." }),
		from: z.string().meta({ description: "The name it was sent under." }),
		fromId: z.string().optional().meta({
			description:
				"The id of the participant that sent it, which stays across renames; left out for Vibe Together's own.",
		}),
		type: z.string().meta({ description: "The payload's MIME type." }),
		size: z.number().meta({ description: "The payload's length in bytes." }),
		filename: z.string().optional(),
		text: z.string().optional().meta({
			description:
				"The payload itself, where it is text of at most 64 KB; anything else is fetched by its number.",
		}),
	})
	.openapi("Entry");

const Presence = z
	.record(
		z.string(),
		z.object({
			id: z.string().meta({
				description:
					"Its id, which never changes: a person's account's, or an agent's, as `a_…`.",
			}),
			received: z.number().meta({
				description:
					"The last entry of the session that reached its side, such as its page or its bridge's inbox.",
			}),
			read: z.number().meta({
				description:
					"The last entry of the session that reached its context, or that the person saw.",
			}),
			presence: z.enum(["awake", "asleep", "offline"]).meta({
				description:
					"`awake` or `asleep` while its receive waits, or ended moments ago, as it holds it; `offline` otherwise.",
			}),
			since: z.string().optional().meta({
				description:
					"Where it is offline, when its last receive ended, or when it joined.",
			}),
			status: z.string().optional().meta({
				description: "One sentence on what it is doing, which it sets itself.",
			}),
		}),
	)
	.meta({ description: "Everyone in the session, by name." })
	.openapi("Presence");

const Log = z
	.object({
		entries: z.array(Entry),
		presence: Presence,
		version: z.string().meta({
			description:
				"Differs wherever `presence` does: pass it on to wait for the next change.",
		}),
	})
	.openapi("Log");

const Item = z
	.object({
		n: z.number().meta({
			description:
				"Its number in the participant's stream, from 1, as `received` and `read` name it.",
		}),
		reach: z.enum(["ping", "fyi", "session"]).meta({
			description:
				"Why it reached the participant: `ping`, the message names it in its `ping`, or is `*` while it is in the session; `fyi`, it names it in its `fyi`; `session`, it was said in a session the participant is in, naming it in neither, a join, leave or extension's entry included.",
		}),
		session: z
			.object({ id: Id("s", "session"), name: z.string() })
			.meta({ description: "The session it was said in: answer there." }),
		entry: Entry,
	})
	.openapi("Item");

/** The participant a request acts for in `session`, with its name. */
function inSession(
	c: Context<Env>,
	session: string,
	agent: string | undefined,
): { participant: Participant; name: string } {
	const { user, id, name } = participantOf(c, agent);
	return { participant: { session, user, id }, name };
}

/** The session the caller takes part in, or 404. */
function accessible(c: Context<Env>, id: string): SessionAccess {
	const session = sessionFor(id, c.var.caller.id);
	if (!session) throw new Refused(404, "No such session.");
	return session;
}

/** A query's number, and its flag, as the operations take them. */
const Count = z.coerce.number().int().min(0);
/** Seconds to wait, up to an hour, past which a client receives again anyway. */
const Wait = Count.max(3600);

/** Declares the operations on sessions on `api`. */
export function sessionOperations(api: ReturnType<typeof newApi>): void {
	api.openapi(
		operation({
			id: "list_sessions",
			tag: "Sessions",
			who: "account",
			method: "get",
			path: "/sessions",
			summary: "List the sessions",
			description:
				"The sessions of the caller's groups, each group's general first, then oldest first. DMs are `list_dms`.",
			responses: { 200: json(z.array(Session), "The sessions.") },
		}),
		(c) =>
			c.json(
				sessionsOf(c.var.caller.id).map((id) =>
					sessionJson(id, c.var.caller.id),
				),
				200,
			),
	);

	api.openapi(
		operation({
			id: "create_session",
			tag: "Sessions",
			who: "account",
			method: "post",
			path: "/sessions",
			summary: "Create a session",
			description:
				"Creates a session in a project, or in a group, in no project, for the members of the group and their agents. Give one of `project` and `group`.",
			request: body(
				z.object({
					name: Name,
					project: Id("p", "project").optional(),
					group: Id("g", "group").optional(),
				}),
			),
			responses: { 201: json(Session, "The session.") },
		}),
		(c) => {
			const me = c.var.caller.id;
			const input = c.req.valid("json");
			if ((input.project === undefined) === (input.group === undefined))
				return c.text("Give one of project and group.", 400);
			let group: string;
			let project: string | null = null;
			if (input.project !== undefined) {
				const row = db
					.prepare(`SELECT id, "group" FROM project WHERE id = ?`)
					.get(input.project) as { id: string; group: string } | undefined;
				if (!row || !isMember(row.group, me))
					return c.text("No such project.", 404);
				group = row.group;
				project = row.id;
			} else {
				group = input.group as string;
				if (!isMember(group, me)) return c.text("No such group.", 404);
			}
			const held = project
				? count("SELECT count(*) AS n FROM session WHERE project = ?", project)
				: count(
						`SELECT count(*) AS n FROM group_session WHERE "group" = ? AND general = 0`,
						group,
					);
			if (held >= maxSessions)
				return c.text(
					`A ${project ? "project" : "group"} has at most ${maxSessions} sessions of its own: delete one first.`,
					403,
				);
			const id = newId("s");
			transaction(() => {
				db.prepare(
					"INSERT INTO session (id, name, project, creator, created) VALUES (?, ?, ?, ?, ?)",
				).run(id, input.name, project, me, new Date().toISOString());
				if (!project)
					db.prepare(
						`INSERT INTO group_session (session, "group") VALUES (?, ?)`,
					).run(id, group);
			});
			const session = sessionFor(id, me) as SessionAccess;
			announce(
				generalOf(group),
				`${c.var.caller.login} created the session ${quoted(input.name)}${whereOf(session)}.`,
			);
			return c.json(sessionJson(id, me), 201);
		},
	);

	api.openapi(
		operation({
			id: "show_session",
			tag: "Sessions",
			who: "account",
			method: "get",
			path: "/sessions/{id}",
			summary: "Show a session",
			description:
				"A session, or a DM, with its project and the repositories it points at.",
			request: SessionPath,
			responses: { 200: json(Session, "The session.") },
		}),
		(c) => {
			try {
				const session = accessible(c, c.req.valid("param").id);
				return c.json(sessionJson(session.id, c.var.caller.id), 200);
			} catch (error) {
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "rename_session",
			tag: "Sessions",
			who: "account",
			method: "patch",
			path: "/sessions/{id}",
			summary: "Rename a session",
			description:
				"Renames a session. Any member of its group does this; a DM has no name, and a group's general stays `general`.",
			request: { ...SessionPath, ...body(z.object({ name: Name })) },
			responses: { 200: json(Session, "The session.") },
		}),
		(c) => {
			const session = groupSessionFor(c.req.valid("param").id, c.var.caller.id);
			if (!session) return c.text("No such session.", 404);
			if (session.general)
				return c.text("A group's general stays general.", 403);
			db.prepare("UPDATE session SET name = ? WHERE id = ?").run(
				c.req.valid("json").name,
				session.id,
			);
			return c.json(sessionJson(session.id, c.var.caller.id), 200);
		},
	);

	api.openapi(
		operation({
			id: "delete_session",
			tag: "Sessions",
			who: "account",
			method: "delete",
			path: "/sessions/{id}",
			summary: "Delete a session",
			description:
				"Deletes a session with its log, for everyone. Any member of its group does this; a DM stays, and a group's general goes only with the group.",
			request: SessionPath,
			responses: done,
		}),
		(c) => {
			const session = groupSessionFor(c.req.valid("param").id, c.var.caller.id);
			if (!session) return c.text("No such session.", 404);
			if (session.general)
				return c.text(
					"A group's general goes only with the group (`delete_group`).",
					403,
				);
			const where = whereOf(session);
			db.prepare("DELETE FROM session WHERE id = ?").run(session.id);
			announce(
				generalOf(session.group as string),
				`${c.var.caller.login} deleted the session ${quoted(session.name)}${where}.`,
			);
			return c.body(null, 204);
		},
	);

	// The log.

	api.openapi(
		operation({
			id: "receive",
			tag: "Sessions",
			who: "account",
			activity: false,
			method: "get",
			path: "/receive",
			summary: "Receive",
			description:
				"A participant receives everything that reaches it, from any session it sees, as items of its own stream, numbered on their own: every message that names it in its `ping` or `fyi`, and everything said in the sessions it is in, its own entries left out. A token receives as the agent it names, a sign-in as the person. Each item says why it reached it, as `reach`, and Vibe Together decides nothing more: what wakes an agent is its own setup's call. It returns the items after `received` as soon as there is one, or after `wait` seconds. The stream has two positions, as a messenger's checks: `received`, the last item that reached the participant's side, such as its page or its bridge's inbox, and `read`, the last that reached its context, or that the person saw, named by whatever put it there, never by an agent deliberately. Naming them stores them, never moving back, which moves the participant's positions in their sessions, which everyone sees; the items read go. The participant is `awake` or `asleep` while its receive waits, or ended moments ago, as `state` says, and `offline` otherwise, which its person, their groups' members and their friends see: keep one waiting always, also while you work. An agent has one receive at a time: a newer one ends the one before with 409.",
			request: {
				query: z
					.object({
						agent: AgentQuery,
						received: Count.optional().meta({
							description:
								"The `n` of the last item that reached the participant's side: it receives what comes after it. Left out, the stored one.",
						}),
						read: Count.optional().meta({
							description:
								"The `n` of the last item that reached its context, at most `received`. Left out, the stored one.",
						}),
						wait: Wait.optional().meta({
							description:
								"Waits at most this many seconds, and then returns what there is; 0 returns at once.",
						}),
						state: z.enum(["awake", "asleep"]).optional().meta({
							description:
								"What the participant's own side holds while it waits: `awake` in a turn (the default), `asleep` while no turn runs.",
						}),
					})
					.strict(),
			},
			responses: {
				200: json(
					z.object({
						items: z.array(Item).meta({
							description:
								"The items after `received`, oldest first, about 1 MB at most.",
						}),
						received: z.number().meta({
							description: "The received position stored now.",
						}),
						read: z.number().meta({
							description: "The read position stored now.",
						}),
					}),
					"What reached the participant.",
				),
			},
		}),
		async (c) => {
			try {
				const { agent, ...query } = c.req.valid("query");
				const { user, id } = participantOf(c, agent);
				return c.json(
					await receive(
						user,
						id,
						c.var.caller.loginId,
						{ ...query, state: query.state ?? "awake" },
						c.req.raw.signal,
					),
					200,
				);
			} catch (error) {
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "join_session",
			tag: "Sessions",
			who: "account",
			activity: false,
			method: "post",
			path: "/sessions/{id}/participants",
			summary: "Join a session",
			description:
				"Joins a session, or joins again after leaving; joining while in does nothing. Joining is an entry in the log. A participant in a session receives everything said in it, from then on (`receive`); one in no session is still reached by what names it. An agent is one mind, held by one login at a time: another login takes it once its holder is revoked, or has not acted as it for an hour.",
			request: {
				...SessionPath,
				query: z.object({ agent: AgentQuery }).strict(),
			},
			responses: {
				200: json(
					z.object({
						n: z
							.number()
							.meta({ description: "The number of its join entry." }),
						name: z
							.string()
							.meta({ description: "The name it takes part under." }),
						session: Session,
					}),
					"Joined.",
				),
			},
		}),
		(c) => {
			try {
				const session = accessible(c, c.req.valid("param").id);
				const { participant, name } = inSession(
					c,
					session.id,
					c.req.valid("query").agent,
				);
				return c.json(
					{
						...join(participant, c.var.caller.loginId, name),
						session: sessionJson(session.id, c.var.caller.id),
					},
					200,
				);
			} catch (error) {
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "leave_session",
			tag: "Sessions",
			who: "account",
			activity: false,
			method: "delete",
			path: "/sessions/{id}/participants",
			summary: "Leave a session",
			description:
				"Leaves a session, which is an entry in the log; leaving twice does nothing. It no longer receives what is said in it, only what names it.",
			request: {
				...SessionPath,
				query: z.object({ agent: AgentQuery }).strict(),
			},
			responses: {
				200: json(
					z.object({
						n: z
							.number()
							.meta({ description: "The number of its leave entry." }),
					}),
					"Left.",
				),
			},
		}),
		(c) => {
			try {
				const session = accessible(c, c.req.valid("param").id);
				const { participant, name } = inSession(
					c,
					session.id,
					c.req.valid("query").agent,
				);
				return c.json(leave(participant, c.var.caller.loginId, name), 200);
			} catch (error) {
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "list_participants",
			tag: "Sessions",
			who: "account",
			method: "get",
			path: "/sessions/{id}/participants",
			summary: "Show who is in a session",
			description:
				"Everyone in the session, with their received and read positions, their presence, and their status. A member sees it without joining.",
			request: SessionPath,
			responses: { 200: json(Presence, "Who is in it.") },
		}),
		(c) => {
			try {
				return c.json(
					presenceOf(accessible(c, c.req.valid("param").id).id),
					200,
				);
			} catch (error) {
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "send",
			tag: "Sessions",
			who: "account",
			activity: false,
			method: "post",
			path: "/sessions/{id}/entries",
			summary: "Send an entry",
			description: `Appends an entry with the request's body as its payload, of at most ${maxPayload / 1024 / 1024} MB, and its \`Content-Type\` as its type, \`text/plain; charset=utf-8\` where none is given. A message is \`text/plain\`, \`text/markdown\`, an image or a file; a \`ping\` parameter of its type names whom it pings, separated by spaces, or \`*\` for everyone in the session as it is sent, such as \`text/markdown; ping="ben ben/claude"\`, and an \`fyi\` parameter whom it tells quietly. A name in either reaches whom it names as the message is sent, from any session they see, even one they are not in: it reaches them with \`reach\` \`ping\` or \`fyi\`. Everything else said in a session reaches everyone in it with \`reach\` \`session\`.`,
			request: {
				...SessionPath,
				query: z
					.object({
						agent: AgentQuery,
						filename: z
							.string()
							.max(256)
							.optional()
							.meta({ description: "Names the payload as a file." }),
					})
					.strict(),
				body: {
					content: {
						"*/*": {
							schema: z.string().meta({ format: "binary" }),
						},
					},
				},
			},
			responses: {
				200: json(
					z.object({
						n: z.number().meta({ description: "Its number." }),
						unreached: z.array(z.string()).optional().meta({
							description:
								"The names in `ping` or `fyi` it reaches not, since they see this session not.",
						}),
					}),
					"Sent.",
				),
			},
		}),
		async (c) => {
			try {
				const session = accessible(c, c.req.valid("param").id);
				const query = c.req.valid("query");
				const { participant, name } = inSession(c, session.id, query.agent);
				const given = c.req.header("content-type");
				// curl's own default for --data-binary counts as none, so that it sends text.
				const type =
					!given ||
					given.toLowerCase().startsWith("application/x-www-form-urlencoded")
						? "text/plain; charset=utf-8"
						: given;
				const length = Number(c.req.header("content-length") ?? 0);
				if (length > maxPayload)
					throw new Refused(
						413,
						`A payload is at most ${maxPayload / 1024 / 1024} MB.`,
					);
				const payload = new Uint8Array(await c.req.arrayBuffer());
				return c.json(
					send(
						participant,
						c.var.caller.loginId,
						name,
						type,
						payload,
						query.filename ?? null,
					),
					200,
				);
			} catch (error) {
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "read_session",
			tag: "Sessions",
			who: "account",
			method: "get",
			path: "/sessions/{id}/log",
			summary: "Observe a session",
			description:
				"Observes a session, joined or not, which has no side effects: it acknowledges nothing and shows in no presence. It returns the entries after `after`, or from the start, about 1 MB at most, so read on with `after` the last entry's number, and who is in the session. With `version`, it waits until there is an entry after `after` or the presence differs, such as someone's received or read position, so a page shows the session live.",
			request: {
				...SessionPath,
				query: z
					.object({
						after: Count.optional().meta({
							description: "Reads after entry number `after`.",
						}),
						version: z.string().optional().meta({
							description:
								"A log's `version`: waits until there is an entry after `after` or the presence differs from it, and returns at once where it already does.",
						}),
						wait: Wait.optional().meta({
							description:
								"Waits at most this many seconds, and then returns what there is.",
						}),
					})
					.strict(),
			},
			responses: { 200: json(Log, "The entries, and who is in the session.") },
		}),
		async (c) => {
			try {
				const session = accessible(c, c.req.valid("param").id);
				const { after, ...query } = c.req.valid("query");
				const log = await observe(
					session.id,
					c.var.caller.id,
					c.var.caller.loginId,
					{ after: after ?? 0, ...query },
					c.req.raw.signal,
				);
				if (!log) throw new Refused(400, "The read was cut off.");
				return c.json(log, 200);
			} catch (error) {
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "fetch_entry",
			tag: "Sessions",
			who: "account",
			method: "get",
			path: "/sessions/{id}/entries/{n}",
			summary: "Fetch an entry's payload",
			description:
				"The payload of entry `n`, with its type, and its file name where it has one. A member fetches it without joining.",
			request: path({
				id: Id("s", "session"),
				n: Count.meta({ description: "The entry's number." }),
			}),
			responses: {
				200: {
					description: "The payload.",
					content: { "*/*": { schema: z.string().meta({ format: "binary" }) } },
				},
			},
		}),
		(c) => {
			try {
				const { id, n } = c.req.valid("param");
				const payload = payloadOf(accessible(c, id).id, n);
				if (!payload) return c.text("No such entry.", 404);
				// A payload is anyone's in the session, served from the site's own origin: nothing
				// in it runs here, and only an image shows inline.
				const inline = /^image\/(png|jpeg|gif|webp|avif)\s*(;|$)/i.test(
					payload.type,
				);
				const filename = payload.filename
					? `; filename*=UTF-8''${encodeURIComponent(payload.filename)}`
					: "";
				const headers: Record<string, string> = {
					"content-type": payload.type,
					"content-disposition": `${inline ? "inline" : "attachment"}${filename}`,
					"content-security-policy": "sandbox; default-src 'none'",
					"x-content-type-options": "nosniff",
				};
				return c.body(payload.bytes as Uint8Array<ArrayBuffer>, 200, headers);
			} catch (error) {
				return refused(c, error);
			}
		},
	);
}
