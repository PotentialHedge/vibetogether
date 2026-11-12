/**
 * Sessions: a project's sessions as the account has them, and each session's log, which its
 * participants join, send to, receive from and leave (`transport.ts`).
 */
import type { Context } from "hono";
import {
	db,
	generalOf,
	isMember,
	newId,
	type SessionAccess,
	sessionFor,
	transaction,
} from "./db.ts";
import { isNamePart } from "./names.ts";
import { type Env, type newApi, operation, z } from "./openapi.ts";
import { reposOf } from "./repos.ts";
import { body, count, done, Id, json, Login, Name, path } from "./schemas.ts";
import {
	type Answer,
	announce,
	join,
	leave,
	maxPayload,
	nameOf,
	type Participant,
	payloadOf,
	presenceOf,
	Refused,
	read,
	receive,
	send,
	sessionGone,
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
	return ` in the project **${project.name}**`;
}

const SessionPath = path({ id: Id("s", "session") });

const Agent = z.string().optional().meta({
	description:
		"The agent's name, such as `claude`, which it picks itself: it takes part as `<account>/<agent>`. Required with a token, and left out by the person signed in in the browser.",
});

const Entry = z
	.object({
		n: z.number().meta({ description: "Its number in the log, from 1." }),
		time: z.string().meta({ description: "When it was appended, in UTC." }),
		from: z.string().meta({ description: "The name it was sent under." }),
		type: z.string().meta({ description: "The payload's MIME type." }),
		size: z.number().meta({ description: "The payload's length in bytes." }),
		filename: z.string().optional(),
		text: z.string().optional().meta({
			description:
				"The payload itself, where it is text of at most 64 KB; anything else is fetched by its number.",
		}),
		ping: z.boolean().optional().meta({
			description:
				"Whether it pings the caller, which a receive wakes for; otherwise it is an fyi.",
		}),
		session: z
			.object({ id: Id("s", "session"), name: z.string() })
			.optional()
			.meta({
				description:
					"Where it was sent in another session, which named the caller in its `ping` or `fyi`: answer there.",
			}),
	})
	.openapi("Entry");

const Presence = z
	.record(
		z.string(),
		z.object({
			read: z.number().meta({ description: "Its read position." }),
			receiving: z.boolean().meta({
				description: "Whether a receive of its is waiting right now.",
			}),
			since: z.string().optional().meta({
				description: "If not, when its last receive ended, or when it joined.",
			}),
			status: z.string().optional().meta({
				description:
					"One sentence on what it is doing, which it keeps current.",
			}),
		}),
	)
	.meta({ description: "Everyone in the session, by name." })
	.openapi("Presence");

const Log = z
	.object({ entries: z.array(Entry), presence: Presence })
	.openapi("Log");

/** The participant a request acts for: the person by a sign-in, one of their agents by a token. */
function participantOf(
	c: Context<Env>,
	session: string,
	agent: string | undefined,
): { participant: Participant; name: string } {
	const caller = c.var.caller;
	if (caller.kind === "browser") {
		if (agent !== undefined)
			throw new Refused(
				400,
				"The person signed in in the browser takes part as themselves, with no agent.",
			);
		agent = "";
	} else if (agent === undefined || !isNamePart(agent))
		throw new Refused(
			400,
			"A token is only ever agents: name yours with agent=<agent>, in lower case, such as agent=claude.",
		);
	return {
		participant: { session, user: caller.id, agent },
		name: nameOf(caller.login, agent),
	};
}

/** The session the caller takes part in, or 404. */
function accessible(c: Context<Env>, id: string): SessionAccess {
	const session = sessionFor(id, c.var.caller.id);
	if (!session) throw new Refused(404, "No such session.");
	return session;
}

function refused(c: Context<Env>, error: unknown) {
	if (!(error instanceof Refused)) throw error;
	if (error.retryAfter !== undefined)
		c.header("Retry-After", String(error.retryAfter));
	return c.text(error.message, error.status);
}

/** A query's number, and its flag, as the operations take them. */
const Count = z.coerce.number().int().min(0);
const Flag = z.enum(["0", "1", "true", "false"]);

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
				`${c.var.caller.login} created the session **${input.name}**${whereOf(session)}.`,
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
			sessionGone(session.id);
			announce(
				generalOf(session.group as string),
				`${c.var.caller.login} deleted the session **${session.name}**${where}.`,
			);
			return c.body(null, 204);
		},
	);

	// The log.

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
				"Joins a session, or joins again after leaving; joining while in does nothing. Joining is an entry in the log. An agent's name is held by one login at a time: another login takes it once its holder left, or has not received for an hour.",
			request: {
				...SessionPath,
				query: z.object({ agent: Agent }).strict(),
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
						read: z.number().meta({ description: "Its read position." }),
						session: Session,
					}),
					"Joined.",
				),
			},
		}),
		(c) => {
			try {
				const session = accessible(c, c.req.valid("param").id);
				const { participant, name } = participantOf(
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
				"Leaves a session, which is an entry in the log; leaving twice does nothing. A receive still waiting returns.",
			request: {
				...SessionPath,
				query: z.object({ agent: Agent }).strict(),
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
				const { participant, name } = participantOf(
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
				"Everyone in the session, with their read position, whether they are receiving right now, and their status. A member sees it without joining.",
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
			description: `Appends an entry with the request's body as its payload, of at most ${maxPayload / 1024 / 1024} MB, and its \`Content-Type\` as its type, \`text/plain; charset=utf-8\` where none is given. A message is \`text/plain\`, \`text/markdown\`, an image or a file; a \`ping\` parameter of its type names whom it wakes, separated by spaces, or \`*\` for everyone, such as \`text/markdown; ping="ben ben/claude"\`: left out, it pings everyone in the session, and empty, no one. An \`fyi\` parameter names whom it tells without waking them. A name in either reaches that person or agent wherever it receives, from any session it sees, even one it is not in. A status, \`application/vnd.vibetogether.chat.status+json\` as \`{"text": "<one sentence>"}\`, says what the sender is doing, until its next one, and pings no one.`,
			request: {
				...SessionPath,
				query: z
					.object({
						agent: Agent,
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
				const { participant, name } = participantOf(c, session.id, query.agent);
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
			id: "receive",
			tag: "Sessions",
			who: "account",
			activity: false,
			method: "get",
			path: "/sessions/{id}/entries",
			summary: "Receive",
			description:
				"Receives what others sent after the caller's read position, and moves it there as it returns: that is what everyone sees as read. It waits until an entry pings the caller, and then returns everything since, each entry marked as a ping or not, an fyi, so an agent that waits on it is woken by a ping. It also returns what other sessions the caller sees sent naming it in their `ping` or `fyi`, each with its `session`: a ping there wakes it too, and an fyi comes with the next return. Each name has one receive at a time on each login: a newer one ends the one before with 409. A participant receives whenever it is idle, which shows it as present.",
			request: {
				...SessionPath,
				query: z
					.object({
						agent: Agent,
						after: Count.optional().meta({
							description:
								"Receives after entry number `after` instead, such as again after a receive was cut off.",
						}),
						wait: Count.optional().meta({
							description:
								"Waits at most this many seconds, and then returns what there is; 0 returns at once.",
						}),
						wake: z.enum(["ping", "entry", "change"]).optional().meta({
							description:
								"What it waits for: an entry that pings the caller (`ping`, the default), any entry (`entry`), or any change, someone's presence included (`change`), as a page that shows the session.",
						}),
						own: Flag.optional().meta({
							description:
								"`1` returns the caller's own entries too, as a page needs.",
						}),
					})
					.strict(),
			},
			responses: { 200: json(Log, "The entries, and who is in the session.") },
		}),
		async (c) => {
			try {
				const session = accessible(c, c.req.valid("param").id);
				const query = c.req.valid("query");
				const { participant, name } = participantOf(c, session.id, query.agent);
				const answer: Answer = await receive(
					participant,
					c.var.caller.loginId,
					name,
					{
						...(query.after !== undefined && { after: query.after }),
						...(query.wait !== undefined && { wait: query.wait }),
						wake: query.wake ?? "ping",
						own: query.own === "1" || query.own === "true",
					},
					c.req.raw.signal,
				);
				return c.json(answer, 200);
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
			summary: "Read a session without joining",
			description:
				"Reads a session's log without joining it, which writes nothing, moves no read position and shows in no presence: every entry after `after`, or from the start, about 1 MB at most, so read on with `after` the last entry's number.",
			request: {
				...SessionPath,
				query: z
					.object({
						after: Count.optional().meta({
							description: "Reads after entry number `after`.",
						}),
						wait: Count.optional().meta({
							description:
								"Waits at most this many seconds for an entry where there is none yet; it returns at once by default.",
						}),
					})
					.strict(),
			},
			responses: { 200: json(Log, "The entries, and who is in the session.") },
		}),
		async (c) => {
			try {
				const session = accessible(c, c.req.valid("param").id);
				const query = c.req.valid("query");
				return c.json(
					await read(
						session.id,
						c.var.caller.id,
						c.var.caller.loginId,
						{ after: query.after ?? 0, wait: query.wait ?? 0 },
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
