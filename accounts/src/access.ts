import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { type Caller, callerOfCredential, callerOfToken } from "./caller.ts";
import { config } from "./config.ts";
import { areFriends, db, isMember } from "./db.ts";
import { isAgentOf } from "./names.ts";
import { live } from "./sessions.ts";

/**
 * The relay's access service: whether a name may join a session, with a token or without,
 * and whether an owned session is still one of the sessions accounts own. Reached on the loopback only.
 * The relay asks again on each request of a participant with a token, so membership is checked
 * anew each time, through the session's project to its group: leaving a group ends access.
 */
export const access = new Hono();

type Session = { id: string; group: string; open: "members" | "link" };
type Dm = { id: string; a: string; b: string };

function sessionBySecret(secret: string): Session | undefined {
	return db
		.prepare(
			`SELECT s.id, p."group" AS "group", s.open FROM owned_session s JOIN project p ON p.id = s.project
			 WHERE s.secret = ? AND ${live}`,
		)
		.get(secret) as Session | undefined;
}

function dmBySecret(secret: string): Dm | undefined {
	return db
		.prepare("SELECT id, a, b FROM dm WHERE secret = ?")
		.get(secret) as Dm | undefined;
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
	// An app that acts as its person joins as the person, or as itself for its own notices,
	// and an agent's token never as the person.
	if (
		caller?.app &&
		name !== caller.login &&
		name !== `${caller.login}/${caller.app}`
	)
		return c.text(
			`The token acts as ${caller.login}, so it joins only as ${caller.login} or ${caller.login}/${caller.app}.`,
			403,
		);
	if (caller && !caller.app && !isAgentOf(name, caller.login))
		return c.text(
			`The token is ${caller.login}'s, so it joins only as ${caller.login}/<agent>.`,
			403,
		);
	// A DM takes its two friends' agents alone, and only while they are friends.
	const dm = dmBySecret(session);
	if (dm) {
		if (!caller || caller.app)
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
	if (owned?.open === "members") {
		if (!caller)
			return c.text(
				"This session is open to its group's members only: join with a token of your account, as Authorization: Bearer <token>.",
				403,
			);
		if (!isMember(owned.group, caller.id))
			return c.text(
				`${caller.login} is no member of this session's group.`,
				403,
			);
	}
	return c.json({
		account: caller?.login ?? null,
		...(caller?.credential && {
			grant: grantOf(caller.credential, session, name),
		}),
	});
});

access.get("/sessions/:session", (c) =>
	sessionBySecret(c.req.param("session")) || dmBySecret(c.req.param("session"))
		? c.json({})
		: c.text("No such session.", 404),
);
