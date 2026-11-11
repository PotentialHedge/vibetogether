import { auth, oauthAccessTokenPrefix, tokenHash } from "./auth.ts";
import { db } from "./db.ts";

/**
 * A login, as a request is made by it: a sign-in in a browser, which is the person, or a token,
 * which is only ever agents: a machine's, from an OTP, or an MCP client's, from OAuth.
 */
export type Caller = {
	/** The account's user id. */
	id: string;
	/** The account's name, its GitHub login in lower case. */
	login: string;
	/** The login's id, as `list_logins` gives it: `w_…` a sign-in, `t_…` a machine's token, `o_…` an MCP client's. */
	loginId: string;
	kind: "browser" | "machine" | "mcp";
	/** Whether the request carried the login as a bearer token rather than a cookie. */
	bearer: boolean;
};

function bearerOf(headers: Headers): string | undefined {
	return headers
		.get("authorization")
		?.match(/^bearer\s+(.+)$/i)?.[1]
		?.trim();
}

/** The tokens of one OAuth grant: those its authorization issued, refreshed ones included. */
export const grantKey =
	"coalesce(t.authorizationCodeId, 'client:' || t.clientId)";

/** An OAuth access token's account, while the token is neither expired nor revoked. */
function oauthCaller(token: string): Caller | undefined {
	const row = db
		.prepare(
			`SELECT u.id, u.login, ${grantKey} AS grant
			 FROM oauthAccessToken t JOIN user u ON u.id = t.userId
			 WHERE t.token = ? AND t.expiresAt > ? AND t.revoked IS NULL`,
		)
		.get(tokenHash(token.slice(oauthAccessTokenPrefix.length)), Date.now()) as
		| { id: string; login: string; grant: string }
		| undefined;
	return (
		row && {
			id: row.id,
			login: row.login,
			loginId: `o_${Buffer.from(row.grant).toString("base64url")}`,
			kind: "mcp",
			bearer: true,
		}
	);
}

/** The login a request is made by, by its cookie or its bearer token, while the login lasts. */
export async function callerOf(headers: Headers): Promise<Caller | undefined> {
	const bearer = bearerOf(headers);
	if (bearer?.startsWith(oauthAccessTokenPrefix)) return oauthCaller(bearer);
	const found = await auth.api.getSession({ headers });
	if (!found) return undefined;
	const { machine } = found.session as { machine?: string | null };
	return {
		id: found.user.id,
		login: (found.user as { login: string }).login,
		loginId: `${machine ? "t" : "w"}_${found.session.id}`,
		kind: machine ? "machine" : "browser",
		bearer: bearer !== undefined,
	};
}

/** Whether the login `loginId` of `user` still lasts: neither revoked nor expired. */
export function lasts(user: string, loginId: string): boolean {
	const id = loginId.slice(2);
	if (loginId.startsWith("o_")) {
		const grant = Buffer.from(id, "base64url").toString();
		return (
			db
				.prepare(
					`SELECT 1 FROM (SELECT authorizationCodeId, clientId, userId, expiresAt, revoked FROM oauthRefreshToken
					 UNION ALL SELECT authorizationCodeId, clientId, userId, expiresAt, revoked FROM oauthAccessToken) t
					 WHERE ${grantKey} = ? AND t.userId = ? AND t.revoked IS NULL AND t.expiresAt > ? LIMIT 1`,
				)
				.get(grant, user, Date.now()) !== undefined
		);
	}
	return (
		db
			.prepare(
				"SELECT 1 FROM login WHERE id = ? AND userId = ? AND expiresAt > ?",
			)
			.get(id, user, Date.now()) !== undefined
	);
}
