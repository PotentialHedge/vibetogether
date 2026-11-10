import { config } from "./config.ts";
import { db, newId } from "./db.ts";

/** A session of a project, as stored. */
export type SessionRow = {
	id: string;
	name: string;
	project: string;
	/** Who created it, null once that account is gone. */
	creator: string | null;
	secret: string | null;
	created: string;
};

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
 * such as when the relay could not be reached as the session was created, or for a DM.
 */
export async function secretOf(
	session: { id: string; secret: string | null },
	table: "owned_session" | "dm" = "owned_session",
): Promise<string> {
	if (session.secret) return session.secret;
	const secret = await createOnRelay();
	db.prepare(
		`UPDATE ${table} SET secret = ? WHERE id = ? AND secret IS NULL`,
	).run(secret, session.id);
	const stored = db
		.prepare(`SELECT secret FROM ${table} WHERE id = ?`)
		.get(session.id) as { secret: string } | undefined;
	return stored?.secret ?? secret;
}

export async function createSession(
	project: string,
	creator: string,
	name: string,
): Promise<SessionRow> {
	const session: SessionRow = {
		id: newId("s"),
		name,
		project,
		creator,
		secret: null,
		created: new Date().toISOString(),
	};
	db.prepare(
		"INSERT INTO owned_session (id, name, project, creator, secret, created) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		session.id,
		session.name,
		session.project,
		session.creator,
		session.secret,
		session.created,
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
