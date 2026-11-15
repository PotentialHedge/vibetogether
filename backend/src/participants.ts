/**
 * Participants: people and their agents. Each has an id that never changes, a name on top, and a
 * status. A person's id is their account's; an agent's is its own, `a_…`, with its name below its
 * person's, `<login>/<name>`.
 */
import { randomInt } from "node:crypto";
import { db } from "./db.ts";
import { isNamePart } from "./names.ts";

export type AgentRow = {
	id: string;
	user: string;
	name: string;
	holder: string | null;
	seen: string | null;
	archived: string | null;
	created: string;
};

/** A new agent's id: `a_` and 8 letters or digits, short and no secret, since a token is the key. */
export function newAgentId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "a_";
	for (let i = 0; i < 8; i++) id += alphabet[randomInt(alphabet.length)];
	return id;
}

/** The agent `id` of `user`, archived or not. */
export function agentOf(id: string, user: string): AgentRow | undefined {
	return db
		.prepare("SELECT * FROM agent WHERE id = ? AND user = ?")
		.get(id, user) as AgentRow | undefined;
}

/** The participant's name now: the person's login, or `<login>/<name>` for an agent. */
export function nameOf(user: string, id: string): string {
	const row = db
		.prepare(
			"SELECT u.login, a.name FROM user u LEFT JOIN agent a ON a.id = ? AND a.user = u.id WHERE u.id = ?",
		)
		.get(id, user) as { login: string; name: string | null } | undefined;
	if (!row) return id;
	return id === user || row.name === null
		? row.login
		: `${row.login}/${row.name}`;
}

/**
 * The participant a name stands for now: `login` the person, `login/name` their agent of that
 * name that is not archived.
 */
export function participantByName(
	name: string,
): { user: string; id: string } | undefined {
	const [login, agent, ...rest] = name.split("/");
	if (!login || rest.length || (agent !== undefined && !isNamePart(agent)))
		return undefined;
	const user = db.prepare("SELECT id FROM user WHERE login = ?").get(login) as
		| { id: string }
		| undefined;
	if (!user) return undefined;
	if (agent === undefined) return { user: user.id, id: user.id };
	const row = db
		.prepare(
			"SELECT id FROM agent WHERE user = ? AND name = ? AND archived IS NULL",
		)
		.get(user.id, agent) as { id: string } | undefined;
	return row && { user: user.id, id: row.id };
}

/** The participant's status, where it has one. */
export function statusOf(id: string): string | undefined {
	return (
		db.prepare("SELECT text FROM status WHERE participant = ?").get(id) as
			| { text: string }
			| undefined
	)?.text;
}
