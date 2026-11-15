/**
 * The transport: each session's log, its participants, and each participant's stream with the
 * receives waiting on it. Observing a session reads its log (`observe`); receiving is a
 * participant's own stream (`receive`), a person's or an agent's alike. What waits is in memory,
 * everything else in the database, so a restart ends the waiting receives, which their clients
 * make again.
 */
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { lasts } from "./caller.ts";
import { changed, versionOf, written } from "./changes.ts";
import { config } from "./config.ts";
import { db, sessionFor, transaction } from "./db.ts";
import { participantByName } from "./participants.ts";

export const joinType = "application/vnd.vibetogether.join";
export const leaveType = "application/vnd.vibetogether.leave";

/** The most a payload holds. */
export const maxPayload = 10 * 1024 * 1024;
/** The most text an entry carries inline; a longer payload is fetched. */
const maxInline = 64 * 1024;
/** About the most one answer carries, of the entries' inline text; it always carries one. */
const maxAnswer = 1024 * 1024;
/** How long an agent stays its login's after that login last acted as it, while no receive of its waits. */
const holdFor = 3600_000;
/** How long a participant stays awake or asleep after its last receive ended, so that receiving again keeps it. */
const graceFor = 60_000;

/**
 * A participant in a session: `id` is the person's own, which is `user`, or one of their agents'.
 */
export type Participant = { session: string; user: string; id: string };

type ParticipantRow = Participant & {
	login: string;
	agentName: string | null;
	inside: number;
	entry: number;
	received: number;
	read: number;
	since: string;
};

export type Entry = {
	n: number;
	time: string;
	from: string;
	fromId?: string;
	type: string;
	size: number;
	filename?: string;
	text?: string;
};

type EntryRow = {
	n: number;
	time: string;
	sender: string;
	participant: string | null;
	type: string;
	size: number;
	filename: string | null;
	text: string | null;
};

/** The state a receive holds, set by its own side: whether it is in a turn. */
export type State = "awake" | "asleep";

/**
 * A participant's presence, by how soon it acts again: `awake` or `asleep`, as its receive holds,
 * while one waits or ended moments ago, `offline` otherwise.
 */
export type PresenceState = State | "offline";

export type Presence = Record<
	string,
	{
		id: string;
		received: number;
		read: number;
		presence: PresenceState;
		since?: string;
		status?: string;
	}
>;

/** The name system messages are sent under. */
export const systemName = "vibetogether";

/** A refusal, with its status and one sentence. */
export class Refused extends Error {
	readonly status: 400 | 403 | 404 | 409 | 413 | 503;
	readonly retryAfter: number | undefined;
	constructor(status: Refused["status"], message: string, retryAfter?: number) {
		super(message);
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

const participants = `SELECT p.*, u.login, a.name AS agentName FROM participant p
	JOIN user u ON u.id = p.user LEFT JOIN agent a ON a.id = p.id`;

function rowName(row: ParticipantRow): string {
	return row.agentName === null ? row.login : `${row.login}/${row.agentName}`;
}

function participantRow(
	p: Pick<Participant, "session" | "id">,
): ParticipantRow | undefined {
	return db
		.prepare(`${participants} WHERE p.session = ? AND p.id = ?`)
		.get(p.session, p.id) as ParticipantRow | undefined;
}

function entryJson(row: EntryRow): Entry {
	return {
		n: row.n,
		time: row.time,
		from: row.sender,
		...(row.participant !== null && { fromId: row.participant }),
		type: row.type,
		size: row.size,
		...(row.filename !== null && { filename: row.filename }),
		...(row.text !== null && { text: row.text }),
	};
}

function lastOf(session: string): number {
	return (
		db
			.prepare("SELECT coalesce(max(n), 0) AS n FROM entry WHERE session = ?")
			.get(session) as { n: number }
	).n;
}

/**
 * A MIME type's parameter, such as `ping` of `text/plain; ping="ben ben/claude"`, read as RFC 9110
 * reads it: a quoted value holds what would otherwise end it, and the first of a name counts.
 */
function parameterOf(type: string, name: string): string | undefined {
	const parameter =
		/;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))\s*/gy;
	const start = type.indexOf(";");
	if (start < 0) return undefined;
	parameter.lastIndex = start;
	for (let m = parameter.exec(type); m; m = parameter.exec(type))
		if (m[1]?.toLowerCase() === name)
			return m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "");
	return undefined;
}

/** Whether an entry of `type` is a message, rather than an extension's, of a `vnd.` type. */
function isMessage(type: string): boolean {
	const subtype = type.split(";")[0]?.split("/")[1]?.trim().toLowerCase() ?? "";
	return !subtype.startsWith("vnd.");
}

/** The names a parameter of `type` lists, separated by spaces. */
export function namesOf(type: string, parameter: string): string[] {
	return (parameterOf(type, parameter) ?? "").split(/\s+/).filter(Boolean);
}

/** The most names one message lists in its `ping` and `fyi` together. */
const maxNamed = 32;

/** Why an item reached a participant: it names it in `ping`, or in `fyi`, or was said in a session it is in. */
export type Reach = "ping" | "fyi" | "session";

/**
 * Delivers entry `n` of `session`, from the participant `sender`, null for Vibe Together's own,
 * as an item of the stream of each participant it reaches: a message reaches every name its `ping`
 * or `fyi` lists, as the name stands as it is sent, where it sees the session, and for an explicit
 * `*` every participant in the session, as a ping; any entry reaches every participant in the
 * session, the sender left out. Returns the participants reached, and the names that see the
 * session not.
 */
function deliver(
	session: string,
	n: number,
	sender: string | null,
	type: string,
): { reached: string[]; unreached: string[] } {
	const unreached: string[] = [];
	const reached = new Map<string, { user: string; reach: Reach }>();
	const inSession = db
		.prepare(`${participants} WHERE p.session = ? AND p.inside = 1`)
		.all(session) as ParticipantRow[];
	if (isMessage(type)) {
		const named = namesOf(type, "ping");
		const ping = new Set(named.filter((name) => name !== "*"));
		const fyi = [
			...new Set(namesOf(type, "fyi").filter((name) => !ping.has(name))),
		];
		if (ping.size + fyi.length > maxNamed)
			throw new Refused(
				400,
				`A message names at most ${maxNamed} in its ping and fyi together.`,
			);
		for (const name of [...ping, ...fyi]) {
			const p = participantByName(name);
			if (p?.id === sender) continue;
			if (!p || !sessionFor(session, p.user)) {
				unreached.push(name);
				continue;
			}
			const pinged = ping.has(name) || reached.get(p.id)?.reach === "ping";
			reached.set(p.id, { user: p.user, reach: pinged ? "ping" : "fyi" });
		}
		// An explicit ping to everyone reaches every participant in the session, as naming each would.
		if (named.includes("*"))
			for (const row of inSession)
				if (row.id !== sender)
					reached.set(row.id, { user: row.user, reach: "ping" });
	}
	for (const row of inSession)
		if (
			row.id !== sender &&
			!reached.has(row.id) &&
			sessionFor(session, row.user)
		)
			reached.set(row.id, { user: row.user, reach: "session" });
	const now = new Date().toISOString();
	for (const [id, { user, reach }] of reached) {
		const { last } = db
			.prepare(
				`INSERT INTO stream_head (participant, user, last, received, read) VALUES (?, ?, 1, 0, 0)
				 ON CONFLICT DO UPDATE SET last = last + 1 RETURNING last`,
			)
			.get(id, user) as { last: number };
		db.prepare(
			"INSERT INTO stream (participant, n, session, entry, reach, created) VALUES (?, ?, ?, ?, ?, ?)",
		).run(id, last, session, n, reach, now);
	}
	return { reached: [...reached.keys()], unreached };
}

/** Who is in the session, with their received and read positions, their presence, and their status. */
export function presenceOf(session: string): Presence {
	const rows = db
		.prepare(
			`SELECT p.*, u.login, a.name AS agentName, st.text FROM participant p
			 JOIN user u ON u.id = p.user LEFT JOIN agent a ON a.id = p.id
			 LEFT JOIN status st ON st.participant = p.id
			 WHERE p.session = ? AND p.inside = 1 ORDER BY u.login, a.name`,
		)
		.all(session) as (ParticipantRow & { text: string | null })[];
	const presence: Presence = {};
	for (const row of rows) {
		const state = presenceOfParticipant(row.id);
		presence[rowName(row)] = {
			id: row.id,
			received: row.received,
			read: row.read,
			presence: state,
			...(state === "offline" && { since: row.since }),
			...(row.text !== null && { status: row.text }),
		};
	}
	return presence;
}

/** A receive waiting on its participant's stream, with the state it holds. */
type Receiver = {
	user: string;
	id: string;
	login: string;
	state: State;
	/** Returns what is after its received position now, or the refusal. */
	end: (refused?: Refused) => void;
};

/** The receives waiting: an agent's one at most, a person's one per page. */
const receivers = new Set<Receiver>();

/** When each participant's last receive started or ended, by its id, and the state it held. */
const lastReceived = new Map<
	string,
	{ user: string; time: number; state: State }
>();

/**
 * A participant's presence: the state its receive holds while one waits, `awake` where any of
 * several does, or ended moments ago, `offline` otherwise.
 */
export function presenceOfParticipant(id: string): PresenceState {
	let state: State | undefined;
	for (const r of receivers)
		if (r.id === id && state !== "awake") state = r.state;
	if (state) return state;
	const last = lastReceived.get(id);
	if (last && Date.now() - last.time < graceFor) return last.state;
	return "offline";
}

/** Every participant awake or asleep now, with its presence. */
export function reachableParticipants(): {
	user: string;
	id: string;
	presence: State;
}[] {
	const ids = new Map<string, string>();
	for (const [id, { user }] of lastReceived) ids.set(id, user);
	for (const r of receivers) ids.set(r.id, r.user);
	return [...ids].flatMap(([id, user]) => {
		const presence = presenceOfParticipant(id);
		return presence === "offline" ? [] : [{ user, id, presence }];
	});
}

/**
 * Makes `change` to what the participant's presence comes from: where the presence changes, what
 * waits for a change is woken.
 */
function presenceChange(id: string, change: () => void): void {
	const was = presenceOfParticipant(id);
	change();
	if (presenceOfParticipant(id) !== was) written();
}

/**
 * Notes that a receive of the participant started or ended, holding `state`: it stays awake or
 * asleep moments longer, so that receiving again keeps it, and goes offline after.
 */
function heard(user: string, id: string, state: State): void {
	lastReceived.set(id, { user, time: Date.now(), state });
	if (id !== user)
		db.prepare("UPDATE agent SET seen = ? WHERE id = ?").run(
			new Date().toISOString(),
			id,
		);
	setTimeout(() => {
		const last = lastReceived.get(id);
		if (last && Date.now() - last.time >= graceFor) {
			lastReceived.delete(id);
			if (presenceOfParticipant(id) === "offline") written();
		}
	}, graceFor + 100).unref();
}

/** Checks that the receive's login lasts, and for an agent that it still holds it, not archived. */
function stillHolds(r: Receiver): Refused | undefined {
	if (!lasts(r.user, r.login)) return new Refused(403, "The login is revoked.");
	if (r.id === r.user) return undefined;
	const agent = db
		.prepare("SELECT holder, archived FROM agent WHERE id = ?")
		.get(r.id) as { holder: string | null; archived: string | null };
	if (agent.archived) return new Refused(403, "The agent is archived.");
	if (agent.holder !== r.login)
		return new Refused(403, "Another login took this agent.");
	return undefined;
}

// Every few seconds, so that a revoked login is cut off on a receive already waiting too.
setInterval(() => {
	for (const r of [...receivers]) {
		const refused = stillHolds(r);
		if (refused) r.end(refused);
	}
}, 5000).unref();

/** Whether an agent's receive waits now. */
const receiving = (id: string) => [...receivers].some((r) => r.id === id);

/**
 * Has `login` act as the agent `id` of `user`, which is one mind at a time, so held by one login:
 * another login takes it once its holder is revoked, or has neither acted as it for an hour nor
 * has a receive of it waiting. A person is no agent, and every login of theirs is them.
 */
export function hold(user: string, id: string, login: string): void {
	if (id === user) return;
	const agent = db
		.prepare(
			"SELECT holder, seen, archived FROM agent WHERE id = ? AND user = ?",
		)
		.get(id, user) as
		| { holder: string | null; seen: string | null; archived: string | null }
		| undefined;
	if (!agent) throw new Refused(404, "No such agent.");
	if (agent.archived)
		throw new Refused(
			403,
			"This agent is archived: it receives and sends no more.",
		);
	const other = agent.holder !== null && agent.holder !== login;
	if (other) {
		const recent =
			agent.seen !== null && Date.now() - Date.parse(agent.seen) < holdFor;
		if (lasts(user, agent.holder as string) && (receiving(id) || recent))
			throw new Refused(
				409,
				"Another login holds this agent, which is one mind at a time: it takes it once that login is revoked, or has not acted as it for an hour.",
			);
	}
	db.prepare("UPDATE agent SET holder = ?, seen = ? WHERE id = ?").run(
		login,
		new Date().toISOString(),
		id,
	);
	if (other)
		for (const r of [...receivers])
			if (r.id === id && r.login !== login)
				r.end(new Refused(403, "Another login took this agent."));
}

/** The participant, joined, or why not. */
function inside(p: Participant): ParticipantRow {
	const row = participantRow(p);
	if (!row?.inside)
		throw new Refused(
			403,
			"Join the session first, or join again after leaving.",
		);
	return row;
}

/** The limits on what one account adds, per hour, and on its receives waiting at once. */
const limits = { entries: 3000, bytes: 1024 * 1024 * 1024, waiting: 64 };
const added = new Map<
	string,
	{ start: number; entries: number; bytes: number }
>();

function adds(user: string, bytes: number): void {
	try {
		const disk = statfsSync(dirname(config.database));
		if (disk.bavail * disk.bsize < 1024 * 1024 * 1024 + bytes)
			throw new Refused(503, "The backend's disk is nearly full.", 3600);
	} catch (error) {
		if (error instanceof Refused) throw error;
	}
	const now = Date.now();
	let count = added.get(user);
	if (!count || now - count.start > 3600_000) {
		count = { start: now, entries: 0, bytes: 0 };
		added.set(user, count);
	}
	if (count.entries + 1 > limits.entries || count.bytes + bytes > limits.bytes)
		throw new Refused(
			503,
			"This account added too much this hour.",
			Math.ceil((count.start + 3600_000 - now) / 1000),
		);
	count.entries += 1;
	count.bytes += bytes;
}

/** Wakes the receives of the participants an entry reached. */
function wake(reached: string[]): void {
	for (const r of [...receivers]) if (reached.includes(r.id)) r.end();
}

/** Appends an entry from `sender`, by its name and its participant's id, null for Vibe Together's own. */
function append(
	session: string,
	sender: { name: string; id: string | null },
	type: string,
	payload: Uint8Array,
	filename: string | null,
): number {
	const n = lastOf(session) + 1;
	const text = inlineText(type, payload);
	db.prepare(
		"INSERT INTO entry (session, n, time, sender, participant, type, size, filename, text, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		session,
		n,
		new Date().toISOString().replace(/\.\d+Z$/, "Z"),
		sender.name,
		sender.id,
		type,
		payload.length,
		filename,
		text ?? null,
		text === undefined && payload.length ? payload : null,
	);
	return n;
}

/** The payload as text where it is short text: any `text/*`, `application/json` or `+json` type. */
function inlineText(type: string, payload: Uint8Array): string | undefined {
	const essence = type.split(";")[0]?.trim().toLowerCase() ?? "";
	const textual =
		essence.startsWith("text/") ||
		essence === "application/json" ||
		essence.endsWith("+json");
	if (!textual || payload.length > maxInline) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(payload);
	} catch {
		return undefined;
	}
}

/** Appends an entry from the participant `p`, and delivers it. */
function appendAs(
	p: Participant,
	name: string,
	type: string,
	payload: Uint8Array,
	filename: string | null,
	change: (n: number) => void = () => {},
): { n: number; unreached: string[] } {
	const { n, reached, unreached } = transaction(() => {
		const n = append(p.session, { name, id: p.id }, type, payload, filename);
		change(n);
		return { n, ...deliver(p.session, n, p.id, type) };
	});
	wake(reached);
	return { n, unreached };
}

/** Joins `p` as `login`, under `name`, or joins again; joining while in does nothing. */
export function join(
	p: Participant,
	login: string,
	name: string,
): { n: number; name: string } {
	hold(p.user, p.id, login);
	const row = participantRow(p);
	if (row?.inside) return { n: row.entry, name };
	// A join is an entry that reaches every participant in the session, so it counts as one sent.
	adds(p.user, 0);
	const { n } = appendAs(p, name, joinType, new Uint8Array(), null, (n) =>
		db
			.prepare(
				`INSERT INTO participant (session, id, user, inside, entry, received, read, since)
				 VALUES (?, ?, ?, 1, ?, 0, 0, ?)
				 ON CONFLICT DO UPDATE SET inside = 1, entry = excluded.entry, since = excluded.since`,
			)
			.run(p.session, p.id, p.user, n, new Date().toISOString()),
	);
	return { n, name };
}

/** Leaves the session. */
export function leave(
	p: Participant,
	login: string,
	name: string,
): { n: number } {
	const row = participantRow(p);
	if (row && !row.inside) return { n: row.entry };
	hold(p.user, p.id, login);
	inside(p);
	adds(p.user, 0);
	return leaveAs(p, name);
}

function leaveAs(p: Participant, name: string): { n: number } {
	const { n } = appendAs(p, name, leaveType, new Uint8Array(), null, (n) =>
		db
			.prepare(
				"UPDATE participant SET inside = 0, entry = ?, since = ? WHERE session = ? AND id = ?",
			)
			.run(n, new Date().toISOString(), p.session, p.id),
	);
	return { n };
}

/** Sends an entry, and returns its number, and the names its `ping` or `fyi` lists that don't see the session. */
export function send(
	p: Participant,
	login: string,
	name: string,
	type: string,
	payload: Uint8Array,
	filename: string | null,
): { n: number; unreached?: string[] } {
	hold(p.user, p.id, login);
	inside(p);
	if (payload.length > maxPayload)
		throw new Refused(
			413,
			`A payload is at most ${maxPayload / 1024 / 1024} MB.`,
		);
	adds(p.user, payload.length);
	const { n, unreached } = appendAs(p, name, type, payload, filename);
	return { n, ...(unreached.length && { unreached }) };
}

/**
 * Archives the agent `id` of `user`, which said it won't come back: it leaves every session it is
 * in, under `name`, receives and sends no more, its stream goes, and its name is free for another.
 */
export function archive(user: string, id: string, name: string): void {
	for (const { session } of db
		.prepare("SELECT session FROM participant WHERE id = ? AND inside = 1")
		.all(id) as { session: string }[])
		leaveAs({ session, user, id }, name);
	transaction(() => {
		db.prepare(
			"UPDATE agent SET archived = ?, holder = NULL WHERE id = ? AND user = ?",
		).run(new Date().toISOString(), id, user);
		db.prepare("DELETE FROM status WHERE participant = ?").run(id);
		db.prepare("DELETE FROM stream_head WHERE participant = ?").run(id);
	});
	for (const r of [...receivers])
		if (r.id === id) r.end(new Refused(403, "The agent is archived."));
}

/**
 * A name as a system message quotes it: a code span, so that a group's or session's name, which
 * its maker chose, reads as a name and never as more of the message.
 */
export function quoted(name: string): string {
	return `\`${name.replace(/[`\s]+/g, " ").trim()}\``;
}

/** The most system messages one session gets in an hour; past it, they are dropped. */
const maxAnnounced = 60;
const announced = new Map<string, { start: number; n: number }>();

/**
 * Posts a system message, from `vibetogether`, to `session`, such as a group's general: markdown,
 * which pings and tells whom `ping` and `fyi` name, and no one where they are empty. Every name in
 * `text` goes through `quoted`.
 */
export function announce(
	session: string,
	text: string,
	{ ping = [], fyi = [] }: { ping?: string[]; fyi?: string[] } = {},
): void {
	const now = Date.now();
	let count = announced.get(session);
	if (!count || now - count.start > 3600_000) {
		if (announced.size > 10_000) announced.clear();
		count = { start: now, n: 0 };
		announced.set(session, count);
	}
	if (++count.n > maxAnnounced) return;
	const type = `text/markdown; charset=utf-8; ping="${ping.join(" ")}"${fyi.length ? `; fyi="${fyi.join(" ")}"` : ""}`;
	const { reached } = transaction(() => {
		const n = append(
			session,
			{ name: systemName, id: null },
			type,
			new TextEncoder().encode(text),
			null,
		);
		return deliver(session, n, null, type);
	});
	wake(reached);
}

/** A session's log after an entry, and who is in it. */
export type Log = { entries: Entry[]; presence: Presence };

/** The entries of `session` after `after`, about one answer's worth, and who is in it. */
function logOf(session: string, after: number): Log {
	const rows = db
		.prepare(
			"SELECT n, time, sender, participant, type, size, filename, text FROM entry WHERE session = ? AND n > ? ORDER BY n LIMIT 1000",
		)
		.all(session, after) as EntryRow[];
	const entries: Entry[] = [];
	let bytes = 0;
	for (const row of rows) {
		bytes += (row.text?.length ?? 0) + 200;
		if (entries.length && bytes > maxAnswer) break;
		entries.push(entryJson(row));
	}
	return { entries, presence: presenceOf(session) };
}

/**
 * Observes a session, which has no side effects: its entries after `after`, and who is in it, with
 * the presence's `version`. Given the `version` of a presence, it waits until there is an entry
 * after `after` or the presence differs from it, at most `wait` seconds. Undefined where the
 * request was cut off.
 */
export async function observe(
	session: string,
	user: string,
	login: string,
	options: {
		after: number;
		version?: string | undefined;
		wait?: number | undefined;
	},
	signal: AbortSignal,
): Promise<(Log & { version: string }) | undefined> {
	const current = () =>
		lasts(user, login) && sessionFor(session, user)
			? logOf(session, options.after)
			: null;
	let log: Log | null | undefined = current();
	if (
		log &&
		!log.entries.length &&
		options.version === versionOf(log.presence) &&
		options.wait !== 0
	)
		log = await changed(user, current, versionOf(log), options.wait, signal);
	if (log === undefined) return undefined;
	if (log === null) throw new Refused(404, "No such session.");
	return { ...log, version: versionOf(log.presence) };
}

/** An item of a participant's stream, as its receive answers it. */
export type Item = {
	n: number;
	reach: Reach;
	session: { id: string; name: string };
	entry: Entry;
};

/** A participant's positions in its stream. */
type Positions = { received: number; read: number };

export type Received = Positions & { items: Item[] };

type ItemRow = EntryRow & {
	item: number;
	reach: Reach;
	session: string;
	sessionName: string;
};

/**
 * Stores the participant's positions in its stream, each at least as it was, `received` at most
 * its last item and `read` at most `received`. Each moves the participant's position of the same
 * name in the sessions of the items it passes, to the last entry there; the items read go.
 * Returns the positions now.
 */
function acknowledge(
	id: string,
	given: { received?: number | undefined; read?: number | undefined },
): Positions {
	const head = (db
		.prepare(
			"SELECT last, received, read FROM stream_head WHERE participant = ?",
		)
		.get(id) as (Positions & { last: number }) | undefined) ?? {
		last: 0,
		received: 0,
		read: 0,
	};
	const received = Math.min(
		Math.max(given.received ?? 0, head.received),
		head.last,
	);
	const read = Math.min(Math.max(given.read ?? 0, head.read), received);
	if (received === head.received && read === head.read) return head;
	transaction(() => {
		for (const [position, from, to] of [
			["received", head.received, received],
			["read", head.read, read],
		] as const)
			for (const { session, entry } of db
				.prepare(
					"SELECT session, max(entry) AS entry FROM stream WHERE participant = ? AND n > ? AND n <= ? GROUP BY session",
				)
				.all(id, from, to) as { session: string; entry: number }[])
				db.prepare(
					`UPDATE participant SET ${position} = ? WHERE session = ? AND id = ? AND ${position} < ?`,
				).run(entry, session, id, entry);
		db.prepare("DELETE FROM stream WHERE participant = ? AND n <= ?").run(
			id,
			read,
		);
		db.prepare(
			"UPDATE stream_head SET received = ?, read = ? WHERE participant = ?",
		).run(received, read, id);
	});
	written();
	return { received, read };
}

/**
 * The participant's items after `after`, about one answer's worth: those of a session it sees no
 * longer go.
 */
function itemsOf(user: string, id: string, after: number): Item[] {
	for (;;) {
		const { items, dropped } = batchOf(user, id, after);
		// A batch all of sessions it sees no longer went: the next may hold what it sees.
		if (items.length || !dropped) return items;
	}
}

function batchOf(
	user: string,
	id: string,
	after: number,
): { items: Item[]; dropped: boolean } {
	const rows = db
		.prepare(
			`SELECT st.n AS item, st.reach, st.session, s.name AS sessionName,
			 e.n, e.time, e.sender, e.participant, e.type, e.size, e.filename, e.text
			 FROM stream st JOIN entry e ON e.session = st.session AND e.n = st.entry
			 JOIN session s ON s.id = st.session
			 WHERE st.participant = ? AND st.n > ? ORDER BY st.n LIMIT 1000`,
		)
		.all(id, after) as ItemRow[];
	const sees = new Map<string, string | undefined>();
	const items: Item[] = [];
	let bytes = 0;
	let dropped = false;
	for (const row of rows) {
		if (!sees.has(row.session))
			sees.set(row.session, sessionFor(row.session, user)?.name);
		const name = sees.get(row.session);
		if (name === undefined) {
			db.prepare("DELETE FROM stream WHERE participant = ? AND n = ?").run(
				id,
				row.item,
			);
			dropped = true;
			continue;
		}
		bytes += (row.text?.length ?? 0) + 200;
		if (items.length && bytes > maxAnswer) break;
		items.push({
			n: row.item,
			reach: row.reach,
			session: { id: row.session, name },
			entry: entryJson(row),
		});
	}
	return { items, dropped };
}

// An item unread for a week goes.
setInterval(
	() =>
		db
			.prepare("DELETE FROM stream WHERE created < ?")
			.run(new Date(Date.now() - 7 * 86400_000).toISOString()),
	3600_000,
).unref();

/**
 * A participant receives its stream: the items after `received`, as given or as stored. Naming
 * `received` and `read` stores them first (`acknowledge`). It returns as soon as there is an item,
 * or after `wait` seconds, and holds the participant's `state` meanwhile: it is awake or asleep
 * while a receive waits, or ended moments ago. An agent has one receive at a time: a newer one
 * ends the one before with 409; a person has one per page.
 */
export function receive(
	user: string,
	id: string,
	login: string,
	options: {
		received?: number | undefined;
		read?: number | undefined;
		wait?: number | undefined;
		state: State;
	},
	signal: AbortSignal,
): Promise<Received> {
	hold(user, id, login);
	if (id !== user)
		for (const r of [...receivers])
			if (r.id === id)
				r.end(
					new Refused(
						409,
						"A newer receive of the same agent replaced this one.",
					),
				);
	const positions = acknowledge(id, options);
	const after = Math.min(
		options.received ?? positions.received,
		positions.received,
	);
	presenceChange(id, () => heard(user, id, options.state));
	const answer = () => ({ items: itemsOf(user, id, after), ...positions });
	const now = answer();
	if (now.items.length || options.wait === 0) return Promise.resolve(now);
	if ([...receivers].filter((r) => r.user === user).length >= limits.waiting)
		return Promise.reject(
			new Refused(503, "This account has too many receives waiting.", 10),
		);
	return new Promise<Received>((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		const receiver: Receiver = {
			user,
			id,
			login,
			state: options.state,
			end: (refused) => {
				if (!stop()) return;
				if (refused) reject(refused);
				else resolve(answer());
			},
		};
		const stop = (): boolean => {
			if (!receivers.has(receiver)) return false;
			presenceChange(id, () => {
				receivers.delete(receiver);
				heard(user, id, options.state);
			});
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			// When its last receive ended, which its sessions show while it is offline.
			db.prepare("UPDATE participant SET since = ? WHERE id = ?").run(
				new Date().toISOString(),
				id,
			);
			return true;
		};
		const abort = () => {
			if (stop()) reject(new Refused(400, "The receive was cut off."));
		};
		presenceChange(id, () => receivers.add(receiver));
		signal.addEventListener("abort", abort);
		const { wait } = options;
		if (wait !== undefined)
			timer = setTimeout(() => receiver.end(), wait * 1000);
	});
}

/** An entry's payload, with its type and file name. */
export function payloadOf(
	session: string,
	n: number,
): { type: string; filename: string | null; bytes: Uint8Array } | undefined {
	const row = db
		.prepare(
			"SELECT type, filename, text, payload FROM entry WHERE session = ? AND n = ?",
		)
		.get(session, n) as
		| {
				type: string;
				filename: string | null;
				text: string | null;
				payload: Uint8Array | null;
		  }
		| undefined;
	if (!row) return undefined;
	return {
		type: row.type,
		filename: row.filename,
		bytes:
			row.text !== null
				? new TextEncoder().encode(row.text)
				: (row.payload ?? new Uint8Array()),
	};
}
