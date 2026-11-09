import { Hono } from "hono";
import { auth } from "./auth.ts";
import { type Caller, callerOf } from "./caller.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { isNamePart } from "./names.ts";
import {
	addressOf,
	createSession,
	type SessionRow,
	secretOf,
} from "./sessions.ts";

type Env = { Variables: { caller: Caller } };

type Person = { id: string; login: string; name: string; image: string | null };

function personByLogin(login: string): Person | undefined {
	return db
		.prepare("SELECT id, login, name, image FROM user WHERE login = ?")
		.get(login) as Person | undefined;
}

function loginOf(id: string): string {
	return (
		db.prepare("SELECT login FROM user WHERE id = ?").get(id) as {
			login: string;
		}
	).login;
}

function areFriends(a: string, b: string): boolean {
	return (
		(
			db
				.prepare(
					`SELECT count(*) AS n FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
				)
				.get(a, b, b, a) as { n: number }
		).n === 2
	);
}

async function sessionJson(session: SessionRow) {
	const members = db
		.prepare(
			"SELECT u.login FROM session_member m JOIN user u ON u.id = m.user WHERE m.session = ? ORDER BY u.login",
		)
		.all(session.id) as { login: string }[];
	let address: string | null = null;
	try {
		address = addressOf(await secretOf(session));
	} catch (error) {
		console.error(`session ${session.id} has no address yet:`, error);
	}
	return {
		id: session.id,
		name: session.name,
		owner: loginOf(session.owner),
		members: members.map((m) => m.login),
		open: session.open,
		app: session.app,
		address,
	};
}

type SessionInput = { name?: string; open?: SessionRow["open"] };

const sessionInputHelp =
	'The body is {"name":"…","open":"members"|"link"}, each optional where the session exists, with a name of at most 100 characters.';

/** A session's name and who it is open to, as a request gives them, or undefined where they are malformed. */
function sessionInput(body: unknown): SessionInput | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const { name, open } = body as { name?: unknown; open?: unknown };
	const input: SessionInput = {};
	if (name !== undefined) {
		if (typeof name !== "string") return undefined;
		const trimmed = name.trim();
		if (trimmed.length === 0 || trimmed.length > 100) return undefined;
		input.name = trimmed;
	}
	if (open !== undefined) {
		if (open !== "members" && open !== "link") return undefined;
		input.open = open;
	}
	return input;
}

async function bodyOf(request: Request): Promise<unknown> {
	const text = await request.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export const api = new Hono<Env>();

/** The most sessions one account owns, since every session it owns lasts. */
const maxSessions = 20;

/**
 * Whether the request is the person's, signed in in the browser, rather than an agent's with a token.
 * Letting others in, as friends, members or by opening a session to its address, is the person's
 * alone, so that an agent told to by someone else can't give them a seat in its person's sessions.
 */
function isPerson(request: Request): boolean {
	return !request.headers.has("authorization");
}

const onlyThePerson =
	"Only the person does this, signed in in the browser, never with a token.";

const origin = new URL(config.url).origin;

api.use(async (c, next) => {
	// A change by the person, signed in in the browser, comes from the account page alone: the
	// session cookie is sent from every site that counts as the same site, other subdomains included.
	const changes = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
	if (changes && isPerson(c.req.raw) && c.req.header("origin") !== origin)
		return c.text("A change by the person comes from the account page.", 403);
	const caller = await callerOf(c.req.raw.headers);
	if (!caller)
		return c.text(
			"Sign in, or send a token as Authorization: Bearer <token>.",
			401,
		);
	c.set("caller", caller);
	await next();
});

api.get("/me", (c) => {
	const person = db
		.prepare("SELECT login, name, image FROM user WHERE id = ?")
		.get(c.var.caller.id) as Person;
	return c.json({
		name: person.login,
		displayName: person.name,
		image: person.image,
	});
});

// Sessions

function sessionOf(id: string): SessionRow | undefined {
	return db.prepare("SELECT * FROM owned_session WHERE id = ?").get(id) as
		| SessionRow
		| undefined;
}

api.get("/sessions", async (c) => {
	const sessions = db
		.prepare(
			`SELECT * FROM owned_session WHERE owner = ? OR id IN (SELECT session FROM session_member WHERE user = ?) ORDER BY created`,
		)
		.all(c.var.caller.id, c.var.caller.id) as SessionRow[];
	return c.json(await Promise.all(sessions.map(sessionJson)));
});

api.post("/sessions", async (c) => {
	const owned = (
		db
			.prepare("SELECT count(*) AS n FROM owned_session WHERE owner = ?")
			.get(c.var.caller.id) as { n: number }
	).n;
	if (owned >= maxSessions)
		return c.text(
			`An account owns at most ${maxSessions} sessions: delete one first.`,
			403,
		);
	const input = sessionInput(await bodyOf(c.req.raw));
	if (!input?.name) return c.text(sessionInputHelp, 400);
	if (input.open === "link" && !isPerson(c.req.raw))
		return c.text(onlyThePerson, 403);
	return c.json(
		await sessionJson(
			await createSession(
				c.var.caller.id,
				input.name,
				input.open ?? "members",
				c.var.caller.app ?? null,
			),
		),
		201,
	);
});

api.patch("/sessions/:id", async (c) => {
	const session = sessionOf(c.req.param("id"));
	if (!session) return c.text("No such session.", 404);
	if (session.owner !== c.var.caller.id)
		return c.text("Only the session's owner changes it.", 403);
	const input = sessionInput(await bodyOf(c.req.raw));
	if (!input) return c.text(sessionInputHelp, 400);
	if (input.open === "link" && !isPerson(c.req.raw))
		return c.text(onlyThePerson, 403);
	const changed = { ...session, ...input };
	db.prepare("UPDATE owned_session SET name = ?, open = ? WHERE id = ?").run(
		changed.name,
		changed.open,
		session.id,
	);
	return c.json(await sessionJson(changed));
});

api.delete("/sessions/:id", (c) => {
	const session = sessionOf(c.req.param("id"));
	if (!session) return c.text("No such session.", 404);
	if (session.owner !== c.var.caller.id)
		return c.text("Only the session's owner deletes it.", 403);
	db.prepare("DELETE FROM owned_session WHERE id = ?").run(session.id);
	return c.body(null, 204);
});

api.put("/sessions/:id/members/:name", async (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const session = sessionOf(c.req.param("id"));
	if (!session) return c.text("No such session.", 404);
	if (session.owner !== c.var.caller.id)
		return c.text("Only the session's owner adds members.", 403);
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (person.id === session.owner)
		return c.text("The owner is in the session already.", 400);
	if (!areFriends(session.owner, person.id))
		return c.text("Only friends of the owner become members.", 403);
	db.prepare(
		"INSERT OR IGNORE INTO session_member (session, user) VALUES (?, ?)",
	).run(session.id, person.id);
	return c.json(await sessionJson(session));
});

api.delete("/sessions/:id/members/:name", (c) => {
	const session = sessionOf(c.req.param("id"));
	if (!session) return c.text("No such session.", 404);
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (session.owner !== c.var.caller.id && person.id !== c.var.caller.id)
		return c.text("Only the owner removes others from a session.", 403);
	db.prepare("DELETE FROM session_member WHERE session = ? AND user = ?").run(
		session.id,
		person.id,
	);
	return c.body(null, 204);
});

// Friends

api.get("/friends", (c) => {
	const me = c.var.caller.id;
	const rows = db
		.prepare(
			`SELECT u.login, u.name, u.image, mine."from" IS NOT NULL AS added, theirs."from" IS NOT NULL AS addedBy
			 FROM user u
			 LEFT JOIN friend mine ON mine."from" = ? AND mine."to" = u.id
			 LEFT JOIN friend theirs ON theirs."from" = u.id AND theirs."to" = ?
			 WHERE mine."from" IS NOT NULL OR theirs."from" IS NOT NULL
			 ORDER BY u.login`,
		)
		.all(me, me) as {
		login: string;
		name: string;
		image: string | null;
		added: number;
		addedBy: number;
	}[];
	return c.json(
		rows.map((row) => ({
			name: row.login,
			displayName: row.name,
			image: row.image,
			state:
				row.added && row.addedBy ? "friends" : row.added ? "asked" : "asking",
		})),
	);
});

api.put("/friends/:name", async (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const me = c.var.caller.id;
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (person.id === me)
		return c.text("You can't add yourself as a friend.", 400);
	db.prepare(
		`INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)`,
	).run(me, person.id, new Date().toISOString());
	return c.body(null, 204);
});

api.delete("/friends/:name", (c) => {
	const me = c.var.caller.id;
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	db.prepare(
		`DELETE FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
	).run(me, person.id, person.id, me);
	// Members are friends of the owner, so they leave each other's sessions too.
	db.prepare(
		"DELETE FROM session_member WHERE (user = ? AND session IN (SELECT id FROM owned_session WHERE owner = ?)) OR (user = ? AND session IN (SELECT id FROM owned_session WHERE owner = ?))",
	).run(person.id, me, me, person.id);
	return c.body(null, 204);
});

// Tokens: each a machine's, a Better Auth session named after the machine, from an OTP or minted
// on the account page, or an MCP client's, an OAuth grant named after the client.

type AgentSession = { id: string; agent: string; createdAt: string | number };
/** One OAuth grant: the tokens that one authorization issued, refreshed ones included. */
type AgentGrant = {
	grant: string;
	name: string | null;
	createdAt: string | number;
};

// The tokens of one grant, by the authorization code that started it, which refreshing keeps.
const grantKey = "coalesce(t.authorizationCodeId, 'client:' || t.clientId)";

function iso(time: string | number | Date): string {
	return new Date(time).toISOString();
}

api.get("/tokens", (c) => {
	const me = c.var.caller.id;
	const sessions = db
		.prepare(
			"SELECT id, agent, createdAt FROM session WHERE userId = ? AND agent IS NOT NULL AND person IS NOT 1 AND expiresAt > ?",
		)
		.all(me, Date.now()) as AgentSession[];
	const grants = db
		.prepare(
			`SELECT ${grantKey} AS grant, c.name, min(t.createdAt) AS createdAt
			 FROM (SELECT authorizationCodeId, clientId, userId, createdAt, expiresAt, revoked FROM oauthRefreshToken
			       UNION ALL SELECT authorizationCodeId, clientId, userId, createdAt, expiresAt, revoked FROM oauthAccessToken) t
			 LEFT JOIN oauthClient c ON c.clientId = t.clientId
			 WHERE t.userId = ? AND t.revoked IS NULL AND t.expiresAt > ?
			 GROUP BY grant ORDER BY createdAt`,
		)
		.all(me, Date.now()) as AgentGrant[];
	return c.json(
		[
			...sessions.map((s) => ({
				id: `t_${s.id}`,
				name: s.agent,
				kind: "machine",
				created: iso(s.createdAt),
			})),
			...grants.map((o) => ({
				id: `o_${Buffer.from(o.grant).toString("base64url")}`,
				name: o.name ?? "an MCP client",
				kind: "mcp",
				created: iso(o.createdAt),
			})),
		].sort((a, b) => a.created.localeCompare(b.created)),
	);
});

api.post("/tokens", async (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const body = (await bodyOf(c.req.raw)) as { name?: unknown } | undefined;
	const name = body?.name;
	if (typeof name !== "string" || !isNamePart(name))
		return c.text(
			"Give the machine's name, in lower case, such as lwirth-server.",
			400,
		);
	const context = await auth.$context;
	const session = await context.internalAdapter.createSession(
		c.var.caller.id,
		false,
		{ agent: name },
	);
	return c.json(
		{
			id: `t_${session.id}`,
			name,
			kind: "machine",
			created: iso(session.createdAt),
			token: session.token,
		},
		201,
	);
});

/** Revokes `me`'s token `id`, as `/tokens` lists it; whether there was one. */
function revokeToken(me: string, id: string): boolean {
	if (id.startsWith("t_"))
		return (
			db
				.prepare(
					"DELETE FROM session WHERE id = ? AND userId = ? AND agent IS NOT NULL AND person IS NOT 1",
				)
				.run(id.slice(2), me).changes > 0
		);
	if (id.startsWith("o_")) {
		const grant = Buffer.from(id.slice(2), "base64url").toString();
		// The consent goes too, so that the client asks the person again rather than getting a token silently.
		const clients = db
			.prepare(
				`SELECT DISTINCT clientId FROM (SELECT authorizationCodeId, clientId, userId FROM oauthRefreshToken
				 UNION ALL SELECT authorizationCodeId, clientId, userId FROM oauthAccessToken) t
				 WHERE ${grantKey} = ? AND userId = ?`,
			)
			.all(grant, me) as { clientId: string }[];
		for (const { clientId } of clients)
			db.prepare(
				"DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?",
			).run(clientId, me);
		const tokens = db
			.prepare(
				`DELETE FROM oauthAccessToken AS t WHERE ${grantKey} = ? AND userId = ?`,
			)
			.run(grant, me);
		const refresh = db
			.prepare(
				`DELETE FROM oauthRefreshToken AS t WHERE ${grantKey} = ? AND userId = ?`,
			)
			.run(grant, me);
		return tokens.changes > 0 || refresh.changes > 0;
	}
	return false;
}

// The token the request carries.
api.delete("/tokens/self", (c) => {
	const { id, token } = c.var.caller;
	if (!token) return c.text("The request carries no token.", 404);
	return revokeToken(id, token)
		? c.body(null, 204)
		: c.text("No such token.", 404);
});

api.delete("/tokens/:id", (c) =>
	revokeToken(c.var.caller.id, c.req.param("id"))
		? c.body(null, 204)
		: c.text("No such token.", 404),
);

// Apps: each acts as its person, by a grant the person approved with an OTP, a Better Auth
// session marked as the person's. An app's grant is no token: tokens only connect agents.

type AppGrant = {
	id: string;
	agent: string;
	claim: string | null;
	createdAt: string | number;
};

api.get("/apps", (c) => {
	const grants = db
		.prepare(
			"SELECT id, agent, claim, createdAt FROM session WHERE userId = ? AND person = 1 AND expiresAt > ? ORDER BY createdAt",
		)
		.all(c.var.caller.id, Date.now()) as AppGrant[];
	return c.json(
		grants.map((g) => ({
			id: `a_${g.id}`,
			name: g.agent,
			for: g.claim,
			created: iso(g.createdAt),
		})),
	);
});

/** Revokes `me`'s app grant `id`, as `/apps` lists it; whether there was one. */
function revokeApp(me: string, id: string): boolean {
	return (
		id.startsWith("a_") &&
		db
			.prepare("DELETE FROM session WHERE id = ? AND userId = ? AND person = 1")
			.run(id.slice(2), me).changes > 0
	);
}

// The grant the request carries, as an app unlinks itself from its side.
api.delete("/apps/self", (c) => {
	const { id, token } = c.var.caller;
	return token && revokeApp(id, token)
		? c.body(null, 204)
		: c.text("The request carries no app's grant.", 404);
});

api.delete("/apps/:id", (c) =>
	revokeApp(c.var.caller.id, c.req.param("id"))
		? c.body(null, 204)
		: c.text("No such app.", 404),
);
