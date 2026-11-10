import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { access } from "./access.ts";
import { api } from "./api.ts";
import { auth, bridgeHeader, bridgeMark, tokenHash } from "./auth.ts";
import { callerOf } from "./caller.ts";
import { config } from "./config.ts";
import { db, isMember, newId } from "./db.ts";

export const app = new Hono();

/**
 * Better Auth's endpoints a request with a token may reach: an agent getting its token, and an
 * MCP client's OAuth. Every other one manages the account's sessions, consents and approvals,
 * which only the person does, in the browser: a token there would let one agent read the
 * others' tokens or mint new ones.
 */
const tokenEndpoints = new Set([
	"/api/auth/device/code",
	"/api/auth/device/token",
	"/api/auth/oauth2/token",
	"/api/auth/oauth2/register",
	"/api/auth/oauth2/revoke",
	"/api/auth/oauth2/userinfo",
]);

// Better Auth's own: signing in, OTPs, and the OAuth server with its metadata.
app.on(["GET", "POST"], ["/api/auth/*", "/.well-known/*"], async (c) => {
	// Only the canonical path, so that no variant, such as with a trailing or a doubled slash,
	// reaches an endpoint past the checks below, which match the path exactly.
	if (c.req.path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1") !== c.req.path)
		return c.text("Not found.", 404);
	if (
		c.req.header("authorization") &&
		!c.req.path.startsWith("/.well-known/") &&
		!tokenEndpoints.has(c.req.path)
	)
		return c.text(
			"Only the person does this, signed in in the browser, never with a token.",
			403,
		);
	if (c.req.path === "/api/auth/device/code")
		return withRequester(unmarked(c.req.raw));
	if (c.req.path === "/api/auth/device/token")
		return withBridge(unmarked(c.req.raw));
	if (c.req.path === "/api/auth/device" && c.req.method === "GET")
		return withRequestOf(c.req.raw);
	if (c.req.path === "/api/auth/device/approve" && c.req.method === "POST")
		return withSession(c.req.raw);
	return auth.handler(c.req.raw);
});

/** The address a request came from, which Caddy sets as X-Forwarded-For. */
function addressOf(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		"an unknown address"
	);
}

/** A request's parameters, as JSON or as a form, the two that Better Auth's device endpoints take. */
async function paramsOf(request: Request): Promise<Record<string, unknown>> {
	const text = await request.clone().text();
	if (
		request.headers
			.get("content-type")
			?.toLowerCase()
			.includes("application/x-www-form-urlencoded")
	)
		return Object.fromEntries(new URLSearchParams(text));
	try {
		const json = JSON.parse(text);
		return json && typeof json === "object" ? json : {};
	} catch {
		return {};
	}
}

/**
 * Whether `params` are from a bridge the service knows, by its `client_id` and `client_secret`.
 * The device flow's `client_id` alone is public, so anyone could claim a bridge's.
 */
function isBridge(params: Record<string, unknown>): boolean {
	const { client_id: id, client_secret: secret } = params;
	if (typeof id !== "string" || typeof secret !== "string") return false;
	const expected = config.bridges.get(id);
	if (!expected) return false;
	const given = createHash("sha256").update(secret).digest();
	return timingSafeEqual(given, Buffer.from(expected, "hex"));
}

/** The request without the mark of a checked bridge, which only the service itself sets. */
function unmarked(request: Request): Request {
	if (!request.headers.has(bridgeHeader)) return request;
	const headers = new Headers(request.headers);
	headers.delete(bridgeHeader);
	return new Request(request, { headers });
}

/** The request marked as from a bridge checked by its secret, which Better Auth limits apart. */
function marked(request: Request): Request {
	const headers = new Headers(request.headers);
	headers.set(bridgeHeader, bridgeMark);
	return new Request(request, { headers });
}

const notABridge = () =>
	Response.json(
		{
			error: "invalid_client",
			error_description:
				"Only a bridge known to the service, by its client_id and client_secret, may be added to a session.",
		},
		{ status: 401 },
	);

/** One line of text of at most `most` characters, or null where there is none. */
function line(value: unknown, most: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/\s+/g, " ").trim().slice(0, most);
	return text || null;
}

/**
 * Asks for an OTP, and keeps when and from where, which the OTP's page shows.
 * The scope `bridge` asks to add a bridge to a session the person picks, which only a bridge may,
 * saying what it bridges in `for`. Where the chat is the sender's alone, such as a private chat
 * with a bot, `identity` is the sender's id on the messenger and `identity_name` their name
 * there, which approving links to the person.
 */
async function withRequester(request: Request): Promise<Response> {
	const from = addressOf(request);
	const params = await paramsOf(request);
	const asks =
		typeof params.scope === "string" &&
		params.scope.split(" ").includes("bridge");
	const bridge = isBridge(params);
	if (asks && !bridge) return notABridge();
	const response = await auth.handler(bridge ? marked(request) : request);
	if (!response.ok) return response;
	const body = (await response.clone().json()) as {
		user_code?: string;
		device_code?: string;
	};
	if (body.user_code && body.device_code) {
		db.prepare("DELETE FROM device_request WHERE requested < ?").run(
			new Date(Date.now() - 86400_000).toISOString(),
		);
		const identity = asks ? line(params.identity, 64) : null;
		db.prepare(
			'INSERT OR REPLACE INTO device_request (user_code, requested, "from", device_code, bridge, claim, identity, identity_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		).run(
			body.user_code,
			new Date().toISOString(),
			from,
			tokenHash(body.device_code),
			asks ? String(params.client_id) : null,
			asks ? line(params.for, 200) : null,
			identity,
			identity && (line(params.identity_name, 100) ?? identity),
		);
	}
	return response;
}

/** Gets an OTP's credential, where a bridge's goes only to the bridge that asked for it. */
async function withBridge(request: Request): Promise<Response> {
	const params = await paramsOf(request);
	const asked = db
		.prepare("SELECT bridge FROM device_request WHERE device_code = ?")
		.get(tokenHash(String(params.device_code ?? ""))) as
		| { bridge: string | null }
		| undefined;
	const bridge = isBridge(params);
	if (asked?.bridge && !bridge) return notABridge();
	return auth.handler(bridge ? marked(request) : request);
}

type Asked = {
	requested: string;
	from: string;
	bridge: string | null;
	claim: string | null;
	identity: string | null;
	identity_name: string | null;
};

function askedOf(userCode: unknown): Asked | undefined {
	const code =
		typeof userCode === "string"
			? userCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase()
			: "";
	return db
		.prepare(
			'SELECT requested, "from", bridge, claim, identity, identity_name FROM device_request WHERE user_code = ?',
		)
		.get(code) as Asked | undefined;
}

/** An OTP as Better Auth gives it, with when and from where it was asked for, and what for. */
async function withRequestOf(request: Request): Promise<Response> {
	const response = await auth.handler(request);
	if (!response.ok) return response;
	const body = (await response.json()) as Record<string, unknown>;
	const asked = askedOf(new URL(request.url).searchParams.get("user_code"));
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	const requestOf = asked && {
		requested: asked.requested,
		from: asked.from,
		bridge: asked.bridge !== null,
		...(asked.bridge !== null && {
			for: asked.claim,
			identity: asked.identity_name,
		}),
	};
	return new Response(JSON.stringify({ ...body, ...requestOf }), {
		status: response.status,
		headers,
	});
}

/** The most bridges one person adds, over all their sessions. */
const maxBridges = 20;

/**
 * Approves an OTP. A bridge's needs `session`, the id of a session of the person's groups, which
 * the bridge is added to, once in each session per person; approving it also links the sender's
 * identity where the bridge named one, from whoever had it linked before.
 */
async function withSession(request: Request): Promise<Response> {
	const params = await paramsOf(request);
	const asked = askedOf(params.userCode);
	if (!asked?.bridge) return auth.handler(request);
	if (params.session === undefined)
		return Response.json(
			{
				error: "invalid_request",
				error_description: "session: pick the session the bridge is added to.",
			},
			{ status: 400 },
		);
	const caller = await callerOf(request.headers);
	if (!caller) return auth.handler(request);
	const session = db
		.prepare(
			`SELECT s.id, p."group" AS "group" FROM owned_session s JOIN project p ON p.id = s.project WHERE s.id = ?`,
		)
		.get(String(params.session)) as { id: string; group: string } | undefined;
	if (!session || !isMember(session.group, caller.id))
		return Response.json(
			{ error: "invalid_request", error_description: "No such session." },
			{ status: 404 },
		);
	const bridges = db
		.prepare(
			"SELECT bridge FROM session WHERE userId = ? AND bridge IS NOT NULL AND agent = ?",
		)
		.all(caller.id, asked.bridge) as { bridge: string }[];
	if (bridges.some((b) => b.bridge === session.id))
		return Response.json(
			{
				error: "invalid_request",
				error_description: `You added ${asked.bridge} to this session already: remove it from the session first, or pick another.`,
			},
			{ status: 409 },
		);
	if (
		(
			db
				.prepare(
					"SELECT count(*) AS n FROM session WHERE userId = ? AND bridge IS NOT NULL",
				)
				.get(caller.id) as { n: number }
		).n >= maxBridges
	)
		return Response.json(
			{
				error: "invalid_request",
				error_description: `A person adds at most ${maxBridges} bridges: remove one first.`,
			},
			{ status: 403 },
		);
	const code = String(params.userCode)
		.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase();
	db.prepare("UPDATE device_request SET session = ? WHERE user_code = ?").run(
		session.id,
		code,
	);
	const headers = new Headers(request.headers);
	headers.set("content-type", "application/json");
	headers.delete("content-length");
	const response = await auth.handler(
		new Request(request.url, {
			method: "POST",
			headers,
			body: JSON.stringify({ userCode: params.userCode }),
		}),
	);
	if (response.ok && asked.identity)
		db.prepare(
			`INSERT INTO identity (id, bridge, external, user, name, created) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (bridge, external) DO UPDATE SET user = excluded.user, name = excluded.name, created = excluded.created`,
		).run(
			newId("i"),
			asked.bridge,
			asked.identity,
			caller.id,
			asked.identity_name ?? asked.identity,
			new Date().toISOString(),
		);
	return response;
}

app.route("/api", api);
app.route("/agentwire", access);
