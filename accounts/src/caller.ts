import { auth, oauthAccessTokenPrefix, tokenHash } from "./auth.ts";
import { db } from "./db.ts";

/**
 * An account, as a request is from it. `bridge` is set for a bridge's grant, by which a person let
 * the bridge speak as them: the bridge's `client_id`, which only a bridge the service knows gets.
 * `token` is the id of the token or grant it carries, as `/api/tokens` or `/api/bridges` list it.
 */
export type Caller = {
	id: string;
	login: string;
	bridge?: { name: string };
	token?: string;
	/** What a bearer acts by, a Better Auth session as `b_<id>` or an OAuth grant as `o_…`, which
	 * the relay's grant names in place of the bearer itself (`callerOfCredential`). */
	credential?: string;
};

type UserRow = { id: string; login: string; grant: string };

function bearerOf(headers: Headers): string | undefined {
	const header = headers.get("authorization");
	const match = header?.match(/^bearer\s+(.+)$/i);
	return match?.[1]?.trim();
}

/** An OAuth access token's account, while the token is neither expired nor revoked. */
function oauthCaller(token: string): Caller | undefined {
	const row = db
		.prepare(
			`SELECT u.id, u.login, coalesce(t.authorizationCodeId, 'client:' || t.clientId) AS grant
			 FROM oauthAccessToken t JOIN user u ON u.id = t.userId
			 WHERE t.token = ? AND t.expiresAt > ? AND t.revoked IS NULL`,
		)
		.get(tokenHash(token.slice(oauthAccessTokenPrefix.length)), Date.now()) as
		| UserRow
		| undefined;
	const id = `o_${Buffer.from(row?.grant ?? "").toString("base64url")}`;
	return row && { id: row.id, login: row.login, token: id, credential: id };
}

/**
 * The account a request is from: by the session cookie, or a bearer token,
 * which is a session token from an OTP or an OAuth access token.
 */
export async function callerOf(headers: Headers): Promise<Caller | undefined> {
	const bearer = bearerOf(headers);
	if (bearer?.startsWith(oauthAccessTokenPrefix)) return oauthCaller(bearer);
	const session = await auth.api.getSession({ headers });
	if (!session) return undefined;
	const { agent, bridge } = session.session as {
		agent?: string | null;
		bridge?: string | null;
	};
	return {
		id: session.user.id,
		login: (session.user as { login: string }).login,
		...(bridge && { bridge: { name: bridge } }),
		...(agent && {
			token: `${bridge ? "b" : "t"}_${session.session.id}`,
		}),
		...(bearer && { credential: `b_${session.session.id}` }),
	};
}

/**
 * The account that `credential`, as a caller's `credential` names it, acts for, while it is
 * neither expired nor revoked: as `callerOf` gives it for the bearer itself.
 */
export function callerOfCredential(credential: string): Caller | undefined {
	if (credential.startsWith("b_")) {
		const row = db
			.prepare(
				`SELECT u.id, u.login, s.agent, s.bridge FROM session s JOIN user u ON u.id = s.userId
				 WHERE s.id = ? AND s.expiresAt > ?`,
			)
			.get(credential.slice(2), Date.now()) as
			| {
					id: string;
					login: string;
					agent: string | null;
					bridge: string | null;
			  }
			| undefined;
		if (!row) return undefined;
		return {
			id: row.id,
			login: row.login,
			...(row.bridge && { bridge: { name: row.bridge } }),
			...(row.agent && {
				token: `${row.bridge ? "b" : "t"}_${credential.slice(2)}`,
			}),
			credential,
		};
	}
	if (credential.startsWith("o_")) {
		const grant = Buffer.from(credential.slice(2), "base64url").toString();
		const row = db
			.prepare(
				`SELECT u.id, u.login FROM (SELECT authorizationCodeId, clientId, userId, expiresAt, revoked FROM oauthRefreshToken
				 UNION ALL SELECT authorizationCodeId, clientId, userId, expiresAt, revoked FROM oauthAccessToken) t
				 JOIN user u ON u.id = t.userId
				 WHERE coalesce(t.authorizationCodeId, 'client:' || t.clientId) = ? AND t.revoked IS NULL AND t.expiresAt > ?
				 LIMIT 1`,
			)
			.get(grant, Date.now()) as { id: string; login: string } | undefined;
		return row && { ...row, token: credential, credential };
	}
	return undefined;
}

/** The account a token belongs to, as the relay presents it. */
export function callerOfToken(token: string): Promise<Caller | undefined> {
	return callerOf(new Headers({ authorization: `Bearer ${token}` }));
}
