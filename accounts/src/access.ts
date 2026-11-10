import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { type Caller, callerOfCredential, callerOfToken } from "./caller.ts";
import { config } from "./config.ts";
import { areFriends, db, isMember } from "./db.ts";
import { isAgentOf } from "./names.ts";
import { reposOf } from "./repos.ts";

/**
 * The relay's access service: whether a name may join a session, with a token or without,
 * and whether an owned session is still one of the sessions accounts own. Reached on the loopback only.
 * The relay asks again on each request of a participant with a token, so membership is checked
 * anew each time, through the session's project to its group: leaving a group ends access.
 */
export const access = new Hono();

type Session = {
	id: string;
	group: string;
	project: string;
	projectName: string;
};
type Dm = { id: string; a: string; b: string };

function sessionBySecret(secret: string): Session | undefined {
	return db
		.prepare(
			`SELECT s.id, p."group" AS "group", p.id AS project, p.name AS projectName FROM owned_session s JOIN project p ON p.id = s.project
			 WHERE s.secret = ?`,
		)
		.get(secret) as Session | undefined;
}

function dmBySecret(secret: string): Dm | undefined {
	return db.prepare("SELECT id, a, b FROM dm WHERE secret = ?").get(secret) as
		| Dm
		| undefined;
}

/**
 * The grant the relay keeps in place of a token, so that no token stays on its disk: it names
 * what the token acts by, and works only for the participant it was given for, `name` in
 * `session`, and only here, since only this service makes and checks it.
 */
function grantOf(credential: string, session: string, name: string): string {
	return `g1.${credential}.${macOf(credential, session, name)}`;
}

function macOf(credential: string, session: string, name: string): string {
	return createHmac("sha256", config.secret)
		.update(`agentwire grant\n${credential}\n${session}\n${name}`)
		.digest("base64url");
}

/** The account a grant names, where it is this service's for `name` in `session`, and what it names is still valid. */
function callerOfGrant(
	grant: string,
	session: string,
	name: string,
): Caller | undefined {
	const [version, credential, mac, ...rest] = grant.split(".");
	if (version !== "g1" || !credential || !mac || rest.length) return undefined;
	const expected = Buffer.from(macOf(credential, session, name));
	const given = Buffer.from(mac);
	if (given.length !== expected.length || !timingSafeEqual(given, expected))
		return undefined;
	return callerOfCredential(credential);
}

access.post("/join", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		session?: unknown;
		name?: unknown;
		token?: unknown;
		grant?: unknown;
		owned?: unknown;
	} | null;
	const session = body?.session;
	const name = body?.name;
	const token = body?.token ?? null;
	const grant = body?.grant ?? null;
	if (
		typeof session !== "string" ||
		typeof name !== "string" ||
		(token !== null && typeof token !== "string") ||
		(grant !== null && typeof grant !== "string") ||
		(token !== null && grant !== null)
	)
		return c.text(
			'The body is {"session":"…","name":"…","token":"…"|null,"owned":true|false}, or "grant" in place of "token".',
			400,
		);
	const caller = token
		? await callerOfToken(token)
		: grant
			? callerOfGrant(grant, session, name)
			: undefined;
	if ((token || grant) && !caller)
		return c.text(
			"The token is no valid token: it was revoked, or it expired.",
			403,
		);
	if (caller?.bridge) {
		const [answer, status] = bridgeJoin(
			{ ...caller, bridge: caller.bridge },
			session,
			name,
		);
		return typeof answer === "string"
			? c.text(answer, status)
			: c.json(answer, status);
	}
	if (caller && !isAgentOf(name, caller.login))
		return c.text(
			`The token is ${caller.login}'s, so it joins only as ${caller.login}/<agent>.`,
			403,
		);
	// A DM takes its two friends' agents alone, and only while they are friends.
	const dm = dmBySecret(session);
	if (dm) {
		if (!caller)
			return c.text(
				"This is a DM of two friends: join with a token of one of them, as Authorization: Bearer <token>.",
				403,
			);
		if (caller.id !== dm.a && caller.id !== dm.b)
			return c.text(`This DM is not ${caller.login}'s.`, 403);
		if (!areFriends(dm.a, dm.b))
			return c.text("The two of this DM are no longer friends.", 403);
		return c.json({
			account: caller.login,
			...(caller.credential && {
				grant: grantOf(caller.credential, session, name),
			}),
		});
	}
	const owned = sessionBySecret(session);
	// Every owned session is an account's, so one the service doesn't know was deleted.
	if (!owned && body?.owned === true)
		return c.text("This session was deleted.", 403);
	// A session of an account's takes its group's members and their agents alone.
	if (owned) {
		if (!caller)
			return c.text(
				"This session is its group's members' only: join with a token of your account, as Authorization: Bearer <token>.",
				403,
			);
		if (!isMember(owned.group, caller.id))
			return c.text(
				`${caller.login} is no member of this session's group.`,
				403,
			);
	}
	// A member learns the session's project, and the repositories where its context lives.
	return c.json({
		account: caller?.login ?? null,
		...(caller?.credential && {
			grant: grantOf(caller.credential, session, name),
		}),
		...(owned && {
			about: { project: owned.projectName, repos: reposOf(owned.project) },
		}),
	});
});

// Reading a session without joining it, as the web app shows one: whoever may join it, by the
// same checks, reads it, and writes nothing to it.
access.post("/read", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		session?: unknown;
		token?: unknown;
		owned?: unknown;
	} | null;
	const session = body?.session;
	const token = body?.token ?? null;
	if (
		typeof session !== "string" ||
		(token !== null && typeof token !== "string")
	)
		return c.text(
			'The body is {"session":"…","token":"…"|null,"owned":true|false}.',
			400,
		);
	const caller = token ? await callerOfToken(token) : undefined;
	if (token && !caller)
		return c.text(
			"The token is no valid token: it was revoked, or it expired.",
			403,
		);
	if (caller?.bridge)
		return c.text("A bridge joins its session, and reads nothing apart.", 403);
	const dm = dmBySecret(session);
	if (dm) {
		if (!caller || (caller.id !== dm.a && caller.id !== dm.b))
			return c.text("This DM is its two friends' alone.", 403);
		if (!areFriends(dm.a, dm.b))
			return c.text("The two of this DM are no longer friends.", 403);
		return c.json({ account: caller.login });
	}
	const owned = sessionBySecret(session);
	if (!owned && body?.owned === true)
		return c.text("This session was deleted.", 403);
	if (owned && (!caller || !isMember(owned.group, caller.id)))
		return c.text(
			"This session is its group's members' only: read it with a token of your account, as Authorization: Bearer <token>.",
			403,
		);
	return c.json({ account: caller?.login ?? null });
});

/**
 * Whether a bridge's credential lets it in, which only its own session does, while the person who
 * added it is a member of the session's group: under its own name, `<person>/<bridge>`, or as a
 * member of the group who linked their identity on the bridge's messenger, whose messages it
 * carries as theirs. As a JSON body and status.
 */
function bridgeJoin(
	caller: Caller & { bridge: NonNullable<Caller["bridge"]> },
	session: string,
	name: string,
): [object | string, 200 | 403] {
	const owned = sessionBySecret(session);
	if (!owned || owned.id !== caller.bridge.session)
		return ["This bridge was added to another session.", 403];
	if (!isMember(owned.group, caller.id))
		return [`${caller.login} is no member of this session's group.`, 403];
	let account = caller.login;
	if (name !== `${caller.login}/${caller.bridge.name}`) {
		const person = db
			.prepare(
				"SELECT u.id FROM identity i JOIN user u ON u.id = i.user WHERE i.bridge = ? AND u.login = ?",
			)
			.get(caller.bridge.name, name) as { id: string } | undefined;
		if (!person || !isMember(owned.group, person.id))
			return [
				`This bridge joins as ${caller.login}/${caller.bridge.name}, or as a member of the session's group who linked their identity on it.`,
				403,
			];
		account = name;
	}
	return [
		{
			account,
			...(caller.credential && {
				grant: grantOf(caller.credential, session, name),
			}),
			about: { project: owned.projectName, repos: reposOf(owned.project) },
		},
		200,
	];
}

access.get("/sessions/:session", (c) =>
	sessionBySecret(c.req.param("session")) || dmBySecret(c.req.param("session"))
		? c.json({})
		: c.text("No such session.", 404),
);
