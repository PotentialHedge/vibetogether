/**
 * Invites: a short link from a person, or their agent, to be their friend, or to join one of
 * their projects. It works once, expires, and its maker revokes it. Accepting it makes the two
 * friends, with their DM, and for a project also makes the invited person a member of its
 * group. The invited person then gets the prompt for their own agent, which gets its token by
 * an OTP they approve.
 */
import { randomInt } from "node:crypto";
import type { Context } from "hono";
import { callerOf } from "./caller.ts";
import { config } from "./config.ts";
import {
	db,
	dmOf,
	generalOf,
	isMember,
	ownGroupOf,
	transaction,
} from "./db.ts";
import { type Env, type newApi, operation, z } from "./openapi.ts";
import { json, Login, path } from "./schemas.ts";
import { announce } from "./transport.ts";

/** How long an invite lasts. */
const inviteLifetime = 7 * 24 * 3600_000;
/** The most invites one person keeps open at once. */
const openInvitesMax = 50;

/** Letters and digits that no one misreads for another. */
const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";

function randomCode(length: number): string {
	let code = "";
	for (let i = 0; i < length; i++) code += alphabet[randomInt(alphabet.length)];
	return code;
}

class Refused extends Error {
	readonly status: 400 | 403 | 404 | 410 | 429;
	constructor(status: Refused["status"], message: string) {
		super(message);
		this.status = status;
	}
}

type InviteRow = {
	code: string;
	inviter: string;
	project: string | null;
	created: string;
	expires: string;
	accepted_by: string | null;
};

type ProjectOf = {
	id: string;
	name: string;
	group: string;
	groupName: string;
	own: number;
};

function projectOf(id: string): ProjectOf | undefined {
	return db
		.prepare(
			`SELECT p.id, p.name, g.id AS "group", g.name AS groupName, g.person IS NOT NULL AS own
			 FROM project p JOIN "group" g ON g.id = p."group" WHERE p.id = ?`,
		)
		.get(id) as ProjectOf | undefined;
}

/** Any member of a project's group invites to it, never to a person's own group, which is them alone. */
function mayInviteTo(project: ProjectOf, user: string): boolean {
	return isMember(project.group, user) && !project.own;
}

const Face = z.object({
	name: Login,
	displayName: z.string(),
	image: z.string().nullable(),
});

function faceOf(user: string): z.infer<typeof Face> {
	const row = db
		.prepare("SELECT login, name, image FROM user WHERE id = ?")
		.get(user) as {
		login: string;
		name: string;
		image: string | null;
	};
	return { name: row.login, displayName: row.name, image: row.image };
}

const ProjectRef = z
	.object({
		id: z.string(),
		name: z.string(),
		group: z.object({ id: z.string(), name: z.string() }),
	})
	.nullable();

function projectRef(
	project: ProjectOf | undefined,
): z.infer<typeof ProjectRef> {
	return project
		? {
				id: project.id,
				name: project.name,
				group: { id: project.group, name: project.groupName },
			}
		: null;
}

const Invite = z
	.object({
		code: z.string(),
		link: z.string().meta({ description: "The link to send." }),
		to: z.enum(["friend", "project"]),
		project: ProjectRef,
		created: z.string(),
		expires: z.string(),
	})
	.openapi("Invite");

function inviteJson(row: InviteRow): z.infer<typeof Invite> {
	return {
		code: row.code,
		link: `${config.url}/i/${row.code}`,
		to: row.project ? "project" : "friend",
		project: projectRef(row.project ? projectOf(row.project) : undefined),
		created: row.created,
		expires: row.expires,
	};
}

function inviteByCode(code: string): InviteRow | undefined {
	return db
		.prepare("SELECT * FROM invite WHERE code = ?")
		.get(code.toLowerCase()) as InviteRow | undefined;
}

function createInvite(
	inviter: string,
	project: string | undefined,
): z.infer<typeof Invite> {
	if (project !== undefined) {
		const p = projectOf(project);
		if (!p || !isMember(p.group, inviter))
			throw new Refused(404, "No such project.");
		if (!mayInviteTo(p, inviter))
			throw new Refused(
				403,
				"A project of your own group takes no one else: invite to be friends instead.",
			);
	}
	const now = new Date();
	const open = (
		db
			.prepare(
				"SELECT count(*) AS n FROM invite WHERE inviter = ? AND accepted_by IS NULL AND expires > ?",
			)
			.get(inviter, now.toISOString()) as { n: number }
	).n;
	if (open >= openInvitesMax)
		throw new Refused(
			429,
			`At most ${openInvitesMax} invites are open at once: revoke one first.`,
		);
	const row: InviteRow = {
		code: randomCode(10),
		inviter,
		project: project ?? null,
		created: now.toISOString(),
		expires: new Date(now.getTime() + inviteLifetime).toISOString(),
		accepted_by: null,
	};
	db.prepare(
		"INSERT INTO invite (code, inviter, project, created, expires) VALUES (?, ?, ?, ?, ?)",
	).run(row.code, row.inviter, row.project, row.created, row.expires);
	return inviteJson(row);
}

/**
 * The invite, as its link shows it, while it can be accepted: by `user`, where they are signed
 * in, also once they accepted it themselves, so that the page shows it again after a reload.
 */
function showInvite(code: string, user: string | undefined) {
	const row = inviteByCode(code);
	if (!row) return undefined;
	const usable = row.accepted_by
		? row.accepted_by === user
		: row.expires > new Date().toISOString();
	if (!usable) return undefined;
	const project = row.project ? projectOf(row.project) : undefined;
	if (row.project && !project) return undefined;
	return {
		inviter: faceOf(row.inviter),
		to: row.project ? ("project" as const) : ("friend" as const),
		project: project ? { name: project.name, group: project.groupName } : null,
		expires: row.expires,
	};
}

function acceptInvite(code: string, user: string) {
	return transaction(() => {
		const row = inviteByCode(code);
		const now = new Date().toISOString();
		if (
			!row ||
			(row.accepted_by && row.accepted_by !== user) ||
			(!row.accepted_by && row.expires <= now)
		)
			throw new Refused(
				410,
				"This invite is used, expired or revoked: ask for a new one.",
			);
		if (row.inviter === user)
			throw new Refused(400, "This is your own invite: send it to someone.");
		const project = row.project ? projectOf(row.project) : undefined;
		// The inviter may have lost the right to invite since, such as by leaving the group.
		if (row.project && (!project || !mayInviteTo(project, row.inviter)))
			throw new Refused(
				410,
				"This invite is no longer valid: ask for a new one.",
			);
		for (const [from, to] of [
			[row.inviter, user],
			[user, row.inviter],
		] as const)
			db.prepare(
				`INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)`,
			).run(from, to, now);
		const dm = dmOf(row.inviter, user);
		const joined = project
			? db
					.prepare(
						`INSERT OR IGNORE INTO group_member ("group", user) VALUES (?, ?)`,
					)
					.run(project.group, user).changes > 0
			: false;
		db.prepare(
			"UPDATE invite SET accepted_by = ?, accepted = coalesce(accepted, ?) WHERE code = ?",
		).run(user, now, row.code);
		if (!row.accepted_by) {
			const login = faceOf(user).name;
			announce(
				generalOf(ownGroupOf(row.inviter)),
				`${login} accepted your invite${project ? ` to the project **${project.name}**` : ""}: you are friends, with a DM.`,
			);
			if (project && joined)
				announce(
					generalOf(project.group),
					`${login} joined the group, by ${faceOf(row.inviter).name}'s invite to the project **${project.name}**.`,
				);
		}
		return { inviter: faceOf(row.inviter), dm, project: projectRef(project) };
	});
}

/** At most `max` lookups a minute from one address, for the operation anyone calls. */
function perAddress(max: number) {
	const seen = new Map<string, { start: number; n: number }>();
	return (request: Request): boolean => {
		const key =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
		const now = Date.now();
		if (seen.size > 10_000) seen.clear();
		const entry = seen.get(key);
		if (!entry || now - entry.start > 60_000) {
			seen.set(key, { start: now, n: 1 });
			return true;
		}
		entry.n += 1;
		return entry.n <= max;
	};
}

const lookups = perAddress(30);

function refused(c: Context<Env>, error: unknown) {
	if (error instanceof Refused) return c.text(error.message, error.status);
	throw error;
}

const Code = path({ code: z.string().min(1).max(64) });

/** Declares invites on `api`. */
export function inviteOperations(api: ReturnType<typeof newApi>): void {
	api.openapi(
		operation({
			id: "create_invite",
			tag: "Invites",
			who: "account",
			method: "post",
			path: "/invites",
			summary: "Create an invite",
			description:
				"Creates a link that invites one person, new to Vibe Together or not, to be the caller's friend, or with `project` to join that project's group too. Opening it, the person signs in with GitHub and accepts, and then gets the prompt for their own agent. Give the `link` to your person to send.",
			request: {
				body: {
					required: false,
					content: {
						"application/json": {
							schema: z.object({
								project: z.string().optional().meta({
									description: "The project's id, as `p_…`, to invite to.",
								}),
							}),
						},
					},
				},
			},
			responses: { 201: json(Invite, "The invite.") },
		}),
		(c) => {
			try {
				const input = c.req.valid("json") as { project?: string } | undefined;
				return c.json(createInvite(c.var.caller.id, input?.project), 201);
			} catch (error) {
				return refused(c, error);
			}
		},
	);

	api.openapi(
		operation({
			id: "list_invites",
			tag: "Invites",
			who: "account",
			method: "get",
			path: "/invites",
			summary: "List the open invites",
			description:
				"The caller's invites that are neither accepted nor expired, newest first.",
			responses: { 200: json(z.array(Invite), "The invites.") },
		}),
		(c) =>
			c.json(
				(
					db
						.prepare(
							"SELECT * FROM invite WHERE inviter = ? AND accepted_by IS NULL AND expires > ? ORDER BY created DESC",
						)
						.all(c.var.caller.id, new Date().toISOString()) as InviteRow[]
				).map(inviteJson),
				200,
			),
	);

	api.openapi(
		operation({
			id: "revoke_invite",
			tag: "Invites",
			who: "account",
			method: "delete",
			path: "/invites/{code}",
			summary: "Revoke an invite",
			description:
				"Revokes an open invite of the caller's: its link stops working.",
			request: Code,
			responses: { 204: { description: "Revoked." } },
		}),
		(c) =>
			db
				.prepare(
					"DELETE FROM invite WHERE code = ? AND inviter = ? AND accepted_by IS NULL",
				)
				.run(c.req.valid("param").code, c.var.caller.id).changes > 0
				? c.body(null, 204)
				: c.text("No such open invite.", 404),
	);

	api.openapi(
		operation({
			id: "show_invite",
			tag: "Invites",
			who: "anyone",
			method: "get",
			path: "/invites/{code}",
			summary: "Show an invite",
			description:
				"What an invite's link shows before signing in: who invites, and to what. Not found once it is used, expired or revoked.",
			request: Code,
			responses: {
				200: json(
					z.object({
						inviter: Face,
						to: z.enum(["friend", "project"]),
						project: z
							.object({ name: z.string(), group: z.string() })
							.nullable(),
						expires: z.string(),
					}),
					"The invite.",
				),
			},
		}),
		async (c) => {
			if (!lookups(c.req.raw))
				return c.text("Too many tries from this address: wait a minute.", 429);
			const caller = await callerOf(c.req.raw.headers);
			const shown = showInvite(c.req.valid("param").code, caller?.id);
			return shown
				? c.json(shown, 200)
				: c.text("This invite is used, expired or revoked.", 404);
		},
	);

	api.openapi(
		operation({
			id: "accept_invite",
			tag: "Invites",
			who: "browser",
			method: "post",
			path: "/invites/{code}/accept",
			summary: "Accept an invite",
			description:
				"The invited person accepts, signed in in the browser: they become the inviter's friends, with a DM, and for a project members of its group.",
			request: Code,
			responses: {
				200: json(
					z.object({
						inviter: Face,
						dm: z.string().meta({ description: "The DM's session id." }),
						project: ProjectRef,
					}),
					"What it led to: the DM with the inviter, and the project, if any.",
				),
			},
		}),
		(c) => {
			try {
				return c.json(
					acceptInvite(c.req.valid("param").code, c.var.caller.id),
					200,
				);
			} catch (error) {
				return refused(c, error);
			}
		},
	);
}
