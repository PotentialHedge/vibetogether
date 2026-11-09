import { auth, oauthAccessTokenPrefix, tokenHash } from "./auth.ts";
import { db } from "./db.ts";

/**
 * An account, as a request is from it. `app` is set for an app's token that acts as the person,
 * the app's `client_id`, which only an app the service knows gets. `token` is the token's id,
 * as `/api/tokens` lists it.
 */
export type Caller = {
	id: string;
	login: string;
	app?: string;
	token?: string;
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
	return (
		row && {
			id: row.id,
			login: row.login,
			token: `o_${Buffer.from(row.grant).toString("base64url")}`,
		}
	);
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
	const { agent, person } = session.session as {
		agent?: string | null;
		person?: boolean | null;
	};
	return {
		id: session.user.id,
		login: (session.user as { login: string }).login,
		...(person === true && agent && { app: agent }),
		...(agent && { token: `t_${session.session.id}` }),
	};
}

/** The account a token belongs to, as the relay presents it. */
export function callerOfToken(token: string): Promise<Caller | undefined> {
	return callerOf(new Headers({ authorization: `Bearer ${token}` }));
}
