import { Hono } from "hono";
import { callerOfToken } from "./caller.ts";
import { db, isMember } from "./db.ts";
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

function sessionBySecret(secret: string): Session | undefined {
	return db
		.prepare(
			`SELECT s.id, p."group" AS "group", s.open FROM owned_session s JOIN project p ON p.id = s.project
			 WHERE s.secret = ? AND ${live}`,
		)
		.get(secret) as Session | undefined;
}

access.post("/join", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		session?: unknown;
		name?: unknown;
		token?: unknown;
		owned?: unknown;
	} | null;
	const session = body?.session;
	const name = body?.name;
	const token = body?.token ?? null;
	if (
		typeof session !== "string" ||
		typeof name !== "string" ||
		(token !== null && typeof token !== "string")
	)
		return c.text(
			'The body is {"session":"…","name":"…","token":"…"|null,"owned":true|false}.',
			400,
		);
	const caller = token ? await callerOfToken(token) : undefined;
	if (token && !caller)
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
	return c.json({ account: caller?.login ?? null });
});

access.get("/sessions/:session", (c) =>
	sessionBySecret(c.req.param("session"))
		? c.json({})
		: c.text("No such session.", 404),
);
