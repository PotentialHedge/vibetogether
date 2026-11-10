/**
 * What agents change in their person's account: each change by a token or an app's grant is kept,
 * as its operation's id and arguments, for the person to see what their agents did, and the
 * changes that let someone in or make tokens are limited per hour, so that an agent talked into
 * them can't spread fast. The person, signed in in the browser, is neither recorded nor limited.
 */
import type { MiddlewareHandler } from "hono";
import type { Caller } from "./caller.ts";
import { db } from "./db.ts";
import type { Env } from "./openapi.ts";

/** The changes limited per account and hour, each on its own. */
const limited: Record<string, number> = {
	add_friend: 20,
	add_group_member: 20,
	create_invite: 20,
	create_token: 20,
};

/** The token's or app's name, as `/api/tokens` and `/api/apps` give it. */
function agentOf(caller: Caller): string {
	// A sign-in's own token, sent as a bearer by a page of the site.
	if (!caller.token) return "a sign-in";
	const id = caller.token;
	if (id.startsWith("o_")) {
		const grant = Buffer.from(id.slice(2), "base64url").toString();
		const row = db
			.prepare(
				`SELECT c.name FROM oauthAccessToken t LEFT JOIN oauthClient c ON c.clientId = t.clientId
				 WHERE coalesce(t.authorizationCodeId, 'client:' || t.clientId) = ? LIMIT 1`,
			)
			.get(grant) as { name: string | null } | undefined;
		return row?.name ?? "an MCP client";
	}
	const row = db
		.prepare("SELECT agent FROM session WHERE id = ?")
		.get(id.slice(2)) as { agent: string | null } | undefined;
	return row?.agent ?? "a token";
}

/** Records and limits the operation `id` where a bearer calls it, a sign-in's own included; a read is neither. */
export function recorded(id: string): MiddlewareHandler<Env> {
	return async (c, next) => {
		const caller = c.var.caller;
		if (!caller.credential || c.req.method === "GET") return next();
		const most = limited[id];
		if (most !== undefined) {
			const since = new Date(Date.now() - 3600_000).toISOString();
			const done = (
				db
					.prepare(
						"SELECT count(*) AS n FROM activity WHERE user = ? AND operation = ? AND created > ?",
					)
					.get(caller.id, id, since) as { n: number }
			).n;
			if (done >= most)
				return c.text(
					`Agents do this at most ${most} times an hour for one account: your person can do it on the website meanwhile.`,
					429,
				);
		}
		await next();
		if (c.res.status >= 400) return;
		let body: unknown;
		try {
			body = (c.req.valid as (target: "json") => unknown)("json");
		} catch {
			body = undefined;
		}
		const args = { ...c.req.param(), ...(body as object | undefined) };
		db.prepare(
			"INSERT INTO activity (user, token, agent, operation, arguments, created) VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			caller.id,
			caller.token ?? caller.credential,
			agentOf(caller),
			id,
			JSON.stringify(args).slice(0, 2000),
			new Date().toISOString(),
		);
	};
}
