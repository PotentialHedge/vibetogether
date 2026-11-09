import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { db } from "./db.ts";

/** A session an account owns, as stored. */
export type SessionRow = {
	id: string;
	name: string;
	owner: string;
	secret: string | null;
	created: string;
	open: "members" | "link";
	/** The app behind the session, such as `messagent` for a Telegram chat, which created it. */
	app: string | null;
};

export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

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
	owner: string,
	name: string,
	open: SessionRow["open"],
	app: string | null = null,
): Promise<SessionRow> {
	const session: SessionRow = {
		id: newId("s"),
		name,
		owner,
		secret: null,
		created: new Date().toISOString(),
		open,
		app,
	};
	db.prepare(
		"INSERT INTO owned_session (id, name, owner, secret, created, open, app) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		session.id,
		session.name,
		session.owner,
		session.secret,
		session.created,
		session.open,
		session.app,
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
