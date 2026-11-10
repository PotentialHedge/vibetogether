import { config } from "./config.ts";
import { db, newId } from "./db.ts";

/** A session of a project, as stored. */
export type SessionRow = {
	id: string;
	name: string;
	project: string;
	secret: string | null;
	created: string;
	open: "members" | "link";
	/** The app's grant that owns the session for the person, such as messagent's for a Telegram chat. */
	app_grant: string | null;
};

/**
 * The condition that an owned session still is: one an app owns ends with the app's grant,
 * however the grant ends, revoked or by Better Auth.
 */
export const live =
	"(app_grant IS NULL OR app_grant IN (SELECT id FROM session WHERE person = 1))";

/** A new owned session on the relay, so that the relay asks this service about it, and the secret in its address. */
async function createOnRelay(): Promise<string> {
	const response = await fetch(`${config.relay}/v2/s?owned`, {
		method: "POST",
	});
	if (!response.ok)
		throw new Error(
			`the relay answered ${response.status} to creating a session`,
		);
	const address = (await response.text()).trim();
	const secret = address.split("/").pop();
	if (!secret) throw new Error(`the relay returned no address: ${address}`);
	return secret;
}

/**
 * The secret of the session's address, created on the relay where it has none yet,
 * such as when the relay could not be reached as the session was created.
 */
export async function secretOf(session: SessionRow): Promise<string> {
	if (session.secret) return session.secret;
	const secret = await createOnRelay();
	db.prepare(
		"UPDATE owned_session SET secret = ? WHERE id = ? AND secret IS NULL",
	).run(secret, session.id);
	const stored = db
		.prepare("SELECT secret FROM owned_session WHERE id = ?")
		.get(session.id) as { secret: string } | undefined;
	return stored?.secret ?? secret;
}

export async function createSession(
	project: string,
	name: string,
	open: SessionRow["open"],
	appGrant: string | null = null,
): Promise<SessionRow> {
	const session: SessionRow = {
		id: newId("s"),
		name,
		project,
		secret: null,
		created: new Date().toISOString(),
		open,
		app_grant: appGrant,
	};
	db.prepare(
		"INSERT INTO owned_session (id, name, project, secret, created, open, app_grant) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		session.id,
		session.name,
		session.project,
		session.secret,
		session.created,
		session.open,
		session.app_grant,
	);
	try {
		session.secret = await secretOf(session);
	} catch (error) {
		console.error(`session ${session.id} has no address yet:`, error);
	}
	return session;
}

export function addressOf(secret: string): string {
	return `${config.relay}/v2/s/${secret}`;
}
