/**
 * Invites and the OTPs a person makes for their agent: the two halves of onboarding, Luis's
 * decisions (2026-11-10).
 *
 * An invite is a short link from a person, or their agent, to be their friend, or to join one of
 * their projects. It is single-use, expires, and its maker revokes it. Accepting it makes the two
 * friends, with their DM, and for a project also makes the invited person a member of its group,
 * which holds the project.
 *
 * An OTP made here is made by the signed-in person, so it is approved already: the site puts it
 * into the prompt the person pastes into their agent, and the agent trades it once for its
 * machine's token. An agent that arrives without one still asks with the device flow (`auth.ts`).
 */

import { createHash, randomInt } from "node:crypto";
import type { Context } from "hono";
import { auth } from "./auth.ts";
import { callerOf } from "./caller.ts";
import { db, dmOf, isMember } from "./db.ts";
import { isNamePart } from "./names.ts";
import { type Env, type newApi, operation, z } from "./openapi.ts";

const day = 24 * 60 * 60 * 1000;

/** How long an invite lasts. */
export const inviteLifetime = 7 * day;
/** How long an OTP lasts: long enough to paste it, short enough not to lie around. */
export const otpLifetime = 10 * 60 * 1000;
/** The most invites one person keeps open at once. */
export const openInvitesMax = 50;

/** Letters and digits that no one misreads for another. */
const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";

function randomCode(length: number): string {
	let code = "";
	for (let i = 0; i < length; i++) code += alphabet[randomInt(alphabet.length)];
	return code;
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
	owner: string;
	app: string | null;
};

function projectOf(id: string): ProjectOf | undefined {
	return db
		.prepare(
			`SELECT p.id, p.name, p.app, g.id AS "group", g.name AS groupName, g.owner
			 FROM project p JOIN "group" g ON g.id = p."group" WHERE p.id = ?`,
		)
		.get(id) as ProjectOf | undefined;
}

/**
 * Who may invite to a project: for now only its group's owner, since only friends of the owner
 * become members. The one place this is decided, until Luis says otherwise.
 */
export function mayInviteTo(project: ProjectOf, user: string): boolean {
	return project.owner === user && project.app === null;
}

export type Invite = {
	code: string;
	link: string;
	to: "friend" | "project";
	project: {
		id: string;
		name: string;
		group: { id: string; name: string };
	} | null;
	created: string;
	expires: string;
};

function inviteJson(row: InviteRow, url: string): Invite {
	const project = row.project ? projectOf(row.project) : undefined;
	return {
		code: row.code,
		link: `${url}/i/${row.code}`,
		to: row.project ? "project" : "friend",
		project: project
			? {
					id: project.id,
					name: project.name,
					group: { id: project.group, name: project.groupName },
				}
			: null,
		created: row.created,
		expires: row.expires,
	};
}

/** Why an invite can't be made, as one line for the caller. */
export class Refused extends Error {
	readonly status: 400 | 403 | 404 | 409 | 410 | 429;
	constructor(message: string, status: Refused["status"]) {
		super(message);
		this.status = status;
	}
}

/** Makes an invite of `inviter`'s, to be friends or, with `project`, to join it. */
export function createInvite(
	inviter: string,
	project: string | undefined,
	url: string,
): Invite {
	if (project !== undefined) {
		const p = projectOf(project);
		if (!p || !isMember(p.group, inviter))
			throw new Refused("No such project.", 404);
		if (!mayInviteTo(p, inviter))
			throw new Refused(
				"Only the owner of the project's group invites to it.",
				403,
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
			`At most ${openInvitesMax} invites are open at once: revoke one first.`,
			429,
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
	return inviteJson(row, url);
}

/** `inviter`'s invites still open, newest first. */
export function openInvites(inviter: string, url: string): Invite[] {
	return (
		db
			.prepare(
				"SELECT * FROM invite WHERE inviter = ? AND accepted_by IS NULL AND expires > ? ORDER BY created DESC",
			)
			.all(inviter, new Date().toISOString()) as InviteRow[]
	).map((row) => inviteJson(row, url));
}

/** Revokes an invite of `inviter`'s; whether there was one still open. */
export function revokeInvite(inviter: string, code: string): boolean {
	return (
		db
			.prepare(
				"DELETE FROM invite WHERE code = ? AND inviter = ? AND accepted_by IS NULL",
			)
			.run(code, inviter).changes > 0
	);
}

function inviteByCode(code: string): InviteRow | undefined {
	return db
		.prepare("SELECT * FROM invite WHERE code = ?")
		.get(code.toLowerCase()) as InviteRow | undefined;
}

type Face = { name: string; displayName: string; image: string | null };

function faceOf(user: string): Face {
	const row = db
		.prepare("SELECT login, name, image FROM user WHERE id = ?")
		.get(user) as {
		login: string;
		name: string;
		image: string | null;
	};
	return { name: row.login, displayName: row.name, image: row.image };
}

/** What an invite shows to whoever holds its link, before they sign in. */
export type InviteShown = {
	inviter: Face;
	to: "friend" | "project";
	project: { name: string; group: string } | null;
	expires: string;
};

/**
 * The invite, as its link shows it, while it can be accepted: by `user`, where they are signed
 * in, also once they accepted it themselves, so that the page shows it again after a reload.
 */
export function showInvite(
	code: string,
	user?: string,
): InviteShown | undefined {
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
		to: row.project ? "project" : "friend",
		project: project ? { name: project.name, group: project.groupName } : null,
		expires: row.expires,
	};
}

/** What accepting an invite led to: the DM with the inviter, and the project joined, if any. */
export type Accepted = {
	inviter: Face;
	dm: string;
	project: {
		id: string;
		name: string;
		group: { id: string; name: string };
	} | null;
};

/** Accepts the invite for `user`: friends with its maker, and for a project a member of its group. */
export function acceptInvite(code: string, user: string): Accepted {
	db.exec("BEGIN IMMEDIATE");
	try {
		const row = inviteByCode(code);
		const now = new Date().toISOString();
		if (
			!row ||
			(row.accepted_by && row.accepted_by !== user) ||
			(!row.accepted_by && row.expires <= now)
		)
			throw new Refused(
				"This invite is used, expired or revoked: ask for a new one.",
				410,
			);
		if (row.inviter === user)
			throw new Refused("This is your own invite: send it to someone.", 400);
		let project: ProjectOf | undefined;
		if (row.project) {
			project = projectOf(row.project);
			// The inviter may have lost the right to invite since, such as by leaving the group.
			if (
				!project ||
				!isMember(project.group, row.inviter) ||
				!mayInviteTo(project, row.inviter)
			)
				throw new Refused(
					"This invite is no longer valid: ask for a new one.",
					410,
				);
		}
		for (const [from, to] of [
			[row.inviter, user],
			[user, row.inviter],
		] as const)
			db.prepare(
				`INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)`,
			).run(from, to, now);
		const dm = dmOf(row.inviter, user);
		if (project)
			db.prepare(
				`INSERT OR IGNORE INTO group_member ("group", user) VALUES (?, ?)`,
			).run(project.group, user);
		db.prepare(
			"UPDATE invite SET accepted_by = ?, accepted = coalesce(accepted, ?) WHERE code = ?",
		).run(user, now, row.code);
		db.exec("COMMIT");
		return {
			inviter: faceOf(row.inviter),
			dm,
			project: project
				? {
						id: project.id,
						name: project.name,
						group: { id: project.group, name: project.groupName },
					}
				: null,
		};
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function otpHash(code: string): string {
	return createHash("sha256")
		.update(code.toUpperCase().replace(/[^A-Z0-9]/g, ""))
		.digest("hex");
}

/** Makes an OTP for `user`'s agent, such as `K7F3-M9Q2`, which nothing shows again. */
export function createOtp(user: string): { code: string; expires: string } {
	const now = Date.now();
	db.prepare("DELETE FROM person_otp WHERE expires <= ?").run(
		new Date(now).toISOString(),
	);
	const raw = randomCode(8).toUpperCase();
	const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
	const expires = new Date(now + otpLifetime).toISOString();
	db.prepare(
		"INSERT INTO person_otp (code, user, created, expires) VALUES (?, ?, ?, ?)",
	).run(otpHash(code), user, new Date(now).toISOString(), expires);
	return { code, expires };
}

/**
 * Trades an OTP, once, for a machine's token named `machine`, of the person who made it.
 * Undefined where the OTP is unknown, used or expired.
 */
export async function redeemOtp(
	code: string,
	machine: string,
): Promise<
	{ user: string; id: string; token: string; created: Date } | undefined
> {
	const row = db
		.prepare(
			"DELETE FROM person_otp WHERE code = ? AND expires > ? RETURNING user",
		)
		.get(otpHash(code), new Date().toISOString()) as
		| { user: string }
		| undefined;
	if (!row) return undefined;
	const context = await auth.$context;
	const session = await context.internalAdapter.createSession(row.user, false, {
		agent: machine,
	});
	return {
		user: row.user,
		id: `t_${session.id}`,
		token: session.token,
		created: new Date(session.createdAt),
	};
}

// The operations.

/** At most `max` requests per minute from one address, for the operations anyone calls. */
function perAddress(max: number) {
	const seen = new Map<string, { start: number; n: number }>();
	return (request: Request): boolean => {
		const address =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
		const now = Date.now();
		if (seen.size > 10_000) seen.clear();
		const entry = seen.get(address);
		if (!entry || now - entry.start > 60_000) {
			seen.set(address, { start: now, n: 1 });
			return true;
		}
		entry.n += 1;
		return entry.n <= max;
	};
}

const lookups = perAddress(30);
const redeems = perAddress(10);
const slowDown = "Too many tries from this address: wait a minute.";

const face = z.object({
	name: z.string().meta({ example: "benarmstrong" }),
	displayName: z.string().meta({ example: "Benedict Armstrong" }),
	image: z.string().nullable(),
});
const projectRef = z
	.object({
		id: z.string(),
		name: z.string().meta({ example: "vibetogether" }),
		group: z.object({
			id: z.string(),
			name: z.string().meta({ example: "Potential Hedge" }),
		}),
	})
	.nullable();
const inviteSchema = z.object({
	code: z.string().meta({ example: "k7f3m9q2xp" }),
	link: z
		.string()
		.meta({ example: "https://vibetogether.agentics.lwirth.com/i/k7f3m9q2xp" }),
	to: z.enum(["friend", "project"]),
	project: projectRef,
	created: z.string(),
	expires: z.string(),
});
const code = z.object({ code: z.string().min(1).max(64) });
const json = <S extends z.ZodType>(schema: S, description: string) => ({
	description,
	content: { "application/json": { schema } },
});

function refused(c: Context<Env>, error: unknown) {
	if (error instanceof Refused) return c.text(error.message, error.status);
	throw error;
}

/** Declares invites and OTPs on `api`. */
export function inviteOperations(
	api: ReturnType<typeof newApi>,
	url: string,
): void {
	api.openapi(
		operation({
			id: "create_invite",
			tag: "Invites",
			who: "account",
			method: "post",
			path: "/invites",
			summary: "Create an invite",
			description:
				"Creates a link that invites one person, new to Vibe Together or not, to be the caller's friend, or with `project` to join that project's group too: only the group's owner invites to a project. The link works once, for 7 days, until it is revoked. Opening it, the person signs in with GitHub and accepts, and then gets the prompt for their own agent. Give the `link` to your person to send.",
			request: {
				body: {
					required: false,
					content: {
						"application/json": {
							schema: z.object({ project: z.string().optional() }),
						},
					},
				},
			},
			responses: { 201: json(inviteSchema, "The invite.") },
		}),
		(c) => {
			if (c.var.caller.app) return c.text("An app makes no invites.", 403);
			try {
				const body = c.req.valid("json") as { project?: string } | undefined;
				return c.json(createInvite(c.var.caller.id, body?.project, url), 201);
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
			responses: { 200: json(z.array(inviteSchema), "The invites.") },
		}),
		(c) => c.json(openInvites(c.var.caller.id, url), 200),
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
			request: { params: code },
			responses: { 204: { description: "Revoked." } },
		}),
		(c) =>
			revokeInvite(c.var.caller.id, c.req.valid("param").code)
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
			request: { params: code },
			responses: {
				200: json(
					z.object({
						inviter: face,
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
			if (!lookups(c.req.raw)) return c.text(slowDown, 429);
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
			request: { params: code },
			responses: {
				200: json(
					z.object({ inviter: face, dm: z.string(), project: projectRef }),
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

	api.openapi(
		operation({
			id: "create_otp",
			// The MCP server's client signs in by OAuth, so this is no tool of it.
			"x-tool": false,
			tag: "Invites",
			who: "browser",
			method: "post",
			path: "/otp",
			summary: "Create an OTP for an agent",
			description:
				"The person, signed in in the browser, makes an OTP that their agent trades once for its machine's token, within 10 minutes. The site puts it into the prompt it shows.",
			responses: {
				201: json(
					z.object({
						code: z.string().meta({ example: "K7F3-M9Q2" }),
						expires: z.string(),
					}),
					"The OTP, which nothing shows again.",
				),
			},
		}),
		(c) => c.json(createOtp(c.var.caller.id), 201),
	);

	api.openapi(
		operation({
			id: "trade_otp",
			// The MCP server's client signs in by OAuth, so this is no tool of it.
			"x-tool": false,
			tag: "Invites",
			who: "anyone",
			method: "post",
			path: "/otp/{code}/token",
			summary: "Trade an OTP for a token",
			description:
				"Trades the OTP the person gave you, once, for your machine's token, which acts for their account. `name` is the machine's hostname in lower case, with only letters, digits and hyphens.",
			request: {
				params: code,
				body: {
					content: {
						"application/json": {
							schema: z.object({
								name: z.string().meta({ example: "ben-laptop" }),
							}),
						},
					},
				},
			},
			responses: {
				201: json(
					z.object({
						id: z.string(),
						name: z.string(),
						kind: z.literal("machine"),
						created: z.string(),
						token: z.string(),
						account: z.string().meta({ example: "benarmstrong" }),
					}),
					"The machine's token, as `token`, which nothing shows again, and the account it acts for.",
				),
			},
		}),
		async (c) => {
			if (!redeems(c.req.raw)) return c.text(slowDown, 429);
			const { name } = c.req.valid("json");
			if (!isNamePart(name))
				return c.text(
					"Give the machine's name, in lower case, such as ben-laptop.",
					400,
				);
			const minted = await redeemOtp(c.req.valid("param").code, name);
			if (!minted)
				return c.text(
					"This OTP is used or expired: ask your person for a new one.",
					410,
				);
			const account = (
				db.prepare("SELECT login FROM user WHERE id = ?").get(minted.user) as {
					login: string;
				}
			).login;
			return c.json(
				{
					id: minted.id,
					name,
					kind: "machine" as const,
					created: minted.created.toISOString(),
					token: minted.token,
					account,
				},
				201,
			);
		},
	);
}
