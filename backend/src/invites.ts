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
	areFriends,
	db,
	dmOf,
	generalOf,
	isMember,
	maxGroups,
	maxMembers,
	ownGroupOf,
	sessionFor,
	transaction,
} from "./db.ts";
import { type Env, type newApi, operation, z } from "./openapi.ts";
import { count, Id, json, Login, path } from "./schemas.ts";
import { Session, sessionJson } from "./sessions.ts";
import { announce, quoted } from "./transport.ts";

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
	/** Only an invite made before invites went to groups: its project's group, landing in its general. */
	project: string | null;
	created: string;
	expires: string;
	accepted_by: string | null;
};

/** The group an invite is to, and the session it was made from, if any. */
type Target = {
	group: string;
	groupName: string;
	own: number;
	session: string | null;
	sessionName: string | null;
};

function targetOf(row: InviteRow): Target | undefined {
	const to = db
		.prepare(
			`SELECT g.id AS "group", g.name AS groupName, g.person IS NOT NULL AS own,
			 s.id AS session, s.name AS sessionName
			 FROM invite_group i JOIN "group" g ON g.id = i."group"
			 LEFT JOIN session s ON s.id = i.session WHERE i.code = ?`,
		)
		.get(row.code) as Target | undefined;
	if (to || !row.project) return to;
	return db
		.prepare(
			`SELECT g.id AS "group", g.name AS groupName, g.person IS NOT NULL AS own,
			 NULL AS session, NULL AS sessionName
			 FROM project p JOIN "group" g ON g.id = p."group" WHERE p.id = ?`,
		)
		.get(row.project) as Target | undefined;
}

/** Any member of a group invites to it, never to a person's own group, which is them alone. */
function mayInviteTo(target: Target, user: string): boolean {
	return isMember(target.group, user) && !target.own;
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

const Ref = (prefix: string, what: string) =>
	z.object({ id: Id(prefix, what), name: z.string() });

const GroupRef = Ref("g", "group").nullable().meta({
	description: "The group it invites to join too; null for friends alone.",
});
const SessionRef = Ref("s", "session").nullable().meta({
	description:
		"The group's session it was made from, where accepting lands; null for the group's general.",
});

const Invite = z
	.object({
		code: z.string(),
		link: z.string().meta({ description: "The link to send." }),
		group: GroupRef,
		session: SessionRef,
		created: z.string(),
		expires: z.string(),
	})
	.openapi("Invite");

function refsOf(target: Target | undefined) {
	return {
		group: target ? { id: target.group, name: target.groupName } : null,
		session:
			target?.session && target.sessionName
				? { id: target.session, name: target.sessionName }
				: null,
	};
}

function inviteJson(row: InviteRow): z.infer<typeof Invite> {
	return {
		code: row.code,
		link: `${config.url}/i/${row.code}`,
		...refsOf(targetOf(row)),
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
	input: { group?: string | undefined; session?: string | undefined },
): z.infer<typeof Invite> {
	let group = input.group;
	let session: string | null = null;
	if (input.session !== undefined) {
		const s = sessionFor(input.session, inviter);
		if (!s?.group) throw new Refused(404, "No such session of a group.");
		if (group !== undefined && group !== s.group)
			throw new Refused(400, "The session is another group's.");
		group = s.group;
		session = s.id;
	}
	if (group !== undefined) {
		const g = db
			.prepare(
				`SELECT id AS "group", name AS groupName, person IS NOT NULL AS own,
				 NULL AS session, NULL AS sessionName FROM "group" WHERE id = ?`,
			)
			.get(group) as Target | undefined;
		if (!g || !isMember(g.group, inviter))
			throw new Refused(404, "No such group.");
		if (!mayInviteTo(g, inviter))
			throw new Refused(
				403,
				"Your own group takes no one else: invite to be friends, or to a group you share.",
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
		project: null,
		created: now.toISOString(),
		expires: new Date(now.getTime() + inviteLifetime).toISOString(),
		accepted_by: null,
	};
	transaction(() => {
		db.prepare(
			"INSERT INTO invite (code, inviter, created, expires) VALUES (?, ?, ?, ?)",
		).run(row.code, row.inviter, row.created, row.expires);
		if (group !== undefined)
			db.prepare(
				`INSERT INTO invite_group (code, "group", session) VALUES (?, ?, ?)`,
			).run(row.code, group, session);
	});
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
	const target = targetOf(row);
	if (row.project && !target) return undefined;
	return {
		inviter: faceOf(row.inviter),
		group: target?.groupName ?? null,
		session: target?.sessionName ?? null,
		expires: row.expires,
	};
}

/**
 * Accepts: the two become friends, where they aren't yet, with their DM, and the invited
 * person joins the group, if any. It lands in the session it was made from, else the group's
 * general, and without a group their DM.
 */
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
		const target = targetOf(row);
		// Accepted already, such as on a reload: it shows where it led, and changes nothing, so
		// that it never undoes a removal from the group or an unfriending since.
		if (row.accepted_by === user) {
			const land =
				target && isMember(target.group, user)
					? (target.session ?? generalOf(target.group))
					: dmOf(row.inviter, user);
			return {
				inviter: faceOf(row.inviter),
				dm: dmOf(row.inviter, user),
				...refsOf(target),
				land: sessionJson(land, user),
			};
		}
		// The inviter may have lost the right to invite since, such as by leaving the group.
		if (row.project && !target)
			throw new Refused(
				410,
				"This invite is no longer valid: ask for a new one.",
			);
		if (target && !mayInviteTo(target, row.inviter))
			throw new Refused(
				410,
				"This invite is no longer valid: ask for a new one.",
			);
		if (target && !isMember(target.group, user)) {
			if (
				count(
					`SELECT count(*) AS n FROM group_member WHERE "group" = ?`,
					target.group,
				) >= maxMembers
			)
				throw new Refused(
					403,
					`The group is full: it has at most ${maxMembers} members.`,
				);
			if (
				count(
					`SELECT count(*) AS n FROM group_member m JOIN "group" g ON g.id = m."group" WHERE m.user = ? AND g.person IS NULL`,
					user,
				) >= maxGroups
			)
				throw new Refused(
					403,
					`You are in ${maxGroups} groups besides your own: leave one first.`,
				);
		}
		const befriended = !areFriends(row.inviter, user);
		for (const [from, to] of [
			[row.inviter, user],
			[user, row.inviter],
		] as const)
			db.prepare(
				`INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)`,
			).run(from, to, now);
		const dm = dmOf(row.inviter, user);
		const joined = target
			? db
					.prepare(
						`INSERT OR IGNORE INTO group_member ("group", user) VALUES (?, ?)`,
					)
					.run(target.group, user).changes > 0
			: false;
		db.prepare(
			"UPDATE invite SET accepted_by = ?, accepted = coalesce(accepted, ?) WHERE code = ?",
		).run(user, now, row.code);
		const land = target ? (target.session ?? generalOf(target.group)) : dm;
		{
			const login = faceOf(user).name;
			const inviterLogin = faceOf(row.inviter).name;
			announce(
				generalOf(ownGroupOf(row.inviter)),
				`${login} accepted your invite${target ? ` to the group ${quoted(target.groupName)}` : ""}${befriended ? ": you are friends, with a DM" : ""}.`,
			);
			if (target && joined)
				announce(
					generalOf(target.group),
					`${login} joined the group, by ${inviterLogin}'s invite.`,
				);
		}
		return {
			inviter: faceOf(row.inviter),
			dm,
			...refsOf(target),
			land: sessionJson(land, user),
		};
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
				"Creates a link that invites one person, new to Vibe Together or not, friends already or not, to be the caller's friend, and with `group` or `session` to join that group too. Accepting lands them, and then their agent, in a session: `session`, else the group's general, and without a group their DM. Opening it, the person signs in with GitHub and accepts, and then gets the prompt for their own agent. Give the `link` to your person to send.",
			request: {
				body: {
					required: false,
					content: {
						"application/json": {
							schema: z.object({
								group: Id("g", "group").optional().meta({
									description: "The group to invite to join.",
								}),
								session: Id("s", "session").optional().meta({
									description:
										"A session of a group, to invite to its group and land in.",
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
				const input = c.req.valid("json") as
					| { group?: string; session?: string }
					| undefined;
				return c.json(createInvite(c.var.caller.id, input ?? {}), 201);
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
						group: z.string().nullable().meta({
							description: "The name of the group it invites to join too.",
						}),
						session: z.string().nullable().meta({
							description: "The name of the session it lands in.",
						}),
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
				"The invited person accepts, signed in in the browser: they become the inviter's friends, where they aren't yet, with a DM, and members of the group, if any. It answers where they land.",
			request: Code,
			responses: {
				200: json(
					z.object({
						inviter: Face,
						dm: z.string().meta({ description: "The DM's session id." }),
						group: GroupRef,
						session: SessionRef,
						land: Session.meta({
							description:
								"The session it lands in: the one it was made from, else the group's general, else the DM.",
						}),
					}),
					"What it led to.",
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
