/**
 * The transport: each session's log, its participants, and the receives waiting on it.
 * Everything waiting is in memory, everything else in the database, so a restart ends the
 * waiting receives, which their clients make again.
 */
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { lasts } from "./caller.ts";
import { written } from "./changes.ts";
import { config } from "./config.ts";
import { db, sessionFor, transaction } from "./db.ts";
import { isNamePart } from "./names.ts";

export const joinType = "application/vnd.vibetogether.join";
export const leaveType = "application/vnd.vibetogether.leave";
export const statusType = "application/vnd.vibetogether.chat.status+json";

/** The most a payload holds. */
export const maxPayload = 10 * 1024 * 1024;
/** The most text an entry carries inline; a longer payload is fetched. */
const maxInline = 64 * 1024;
/** About the most one answer carries, of the entries' inline text; it always carries one. */
const maxAnswer = 1024 * 1024;
/** How long a name an agent holds stays its login's after its last receive, unless it leaves. */
const holdFor = 3600_000;
/** How long an agent stays online after its last receive ended, so that receiving again keeps it. */
const onlineFor = 60_000;

/** A participant: a person, where `agent` is empty, or one of their agents. */
export type Participant = { session: string; user: string; agent: string };

type ParticipantRow = Participant & {
	login: string;
	inside: number;
	entry: number;
	read: number;
	since: string;
	holder: string | null;
	status: string | null;
};

export type Entry = {
	n: number;
	time: string;
	from: string;
	type: string;
	size: number;
	filename?: string;
	text?: string;
};

type EntryRow = {
	n: number;
	time: string;
	sender: string;
	type: string;
	size: number;
	filename: string | null;
	text: string | null;
};

export type Presence = Record<
	string,
	{ read: number; receiving: boolean; since?: string; status?: string }
>;

/** An entry as a receive answers it: whether it pings, and the session it was sent in, where that is another. */
export type Received = Entry & {
	ping?: boolean;
	session?: { id: string; name: string };
};

export type Answer = {
	entries: Received[];
	presence: Presence;
};

/** The name system messages are sent under. */
export const systemName = "vibetogether";

/** What wakes a receive: an entry that pings it, any entry, or any change, presence included. */
export type Wake = "ping" | "entry" | "change";

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

export function nameOf(login: string, agent: string): string {
	return agent ? `${login}/${agent}` : login;
}

const participants = `SELECT p.*, u.login FROM participant p JOIN user u ON u.id = p.user`;

function participantRow(p: Participant): ParticipantRow | undefined {
	return db
		.prepare(
			`${participants} WHERE p.session = ? AND p.user = ? AND p.agent = ?`,
		)
		.get(p.session, p.user, p.agent) as ParticipantRow | undefined;
}

function entryJson(row: EntryRow): Entry {
	return {
		n: row.n,
		time: row.time,
		from: row.sender,
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
function namesOf(type: string, parameter: string): string[] {
	return (parameterOf(type, parameter) ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Whether `entry` pings `name`: a `ping` parameter names whom it pings, or `*` everyone; left
 * out, a message pings everyone, and an entry of an extension, of a `vnd.` type, no one.
 */
export function pings(type: string, name: string): boolean {
	if (parameterOf(type, "ping") === undefined) return isMessage(type);
	const names = namesOf(type, "ping");
	return names.includes("*") || names.includes(name);
}

/** The most names one message lists in its `ping` and `fyi` together. */
const maxNamed = 32;

/** A participant a name stands for, as `login` or `login/agent`, where it is an account's. */
function participantByName(
	name: string,
): { user: string; agent: string } | undefined {
	const [login, agent = "", ...rest] = name.split("/");
	if (!login || rest.length || (name.includes("/") && !isNamePart(agent)))
		return undefined;
	const user = db.prepare("SELECT id FROM user WHERE login = ?").get(login) as
		| { id: string }
		| undefined;
	return user && { user: user.id, agent };
}

/**
 * Notes entry `n` of `session` for every name its `ping` or `fyi` lists, `*` aside, which sees
 * the session, so that it reaches them in any session they receive in. Returns the participants
 * noted, and the names that see it not.
 */
function mention(
	session: string,
	n: number,
	sender: string,
	type: string,
): { noted: { user: string; agent: string }[]; unreached: string[] } {
	const noted: { user: string; agent: string }[] = [];
	const unreached: string[] = [];
	if (!isMessage(type)) return { noted, unreached };
	const now = new Date();
	const ping = new Set(namesOf(type, "ping").filter((name) => name !== "*"));
	const fyi = [
		...new Set(namesOf(type, "fyi").filter((name) => !ping.has(name))),
	];
	if (ping.size + fyi.length > maxNamed)
		throw new Refused(
			400,
			`A message names at most ${maxNamed} in its ping and fyi together.`,
		);
	for (const name of [...ping, ...fyi]) {
		if (name === sender) continue;
		const p = participantByName(name);
		if (!p || !sessionFor(session, p.user)) {
			unreached.push(name);
			continue;
		}
		db.prepare(
			"INSERT INTO mention (user, agent, session, n, ping, created) VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			p.user,
			p.agent,
			session,
			n,
			ping.has(name) ? 1 : 0,
			now.toISOString(),
		);
		noted.push(p);
	}
	return { noted, unreached };
}

/** Who is in the session, with their read position, whether they are receiving, and their status. */
export function presenceOf(session: string): Presence {
	const rows = db
		.prepare(
			`${participants} WHERE p.session = ? AND p.inside = 1 ORDER BY u.login, p.agent`,
		)
		.all(session) as ParticipantRow[];
	const presence: Presence = {};
	for (const row of rows) {
		const receiving = [...waiting].some(
			(w) =>
				w.session === session && w.user === row.user && w.agent === row.agent,
		);
		presence[nameOf(row.login, row.agent)] = {
			read: row.read,
			receiving,
			...(!receiving && { since: row.since }),
			...(row.status && { status: row.status }),
		};
	}
	return presence;
}

/** A receive or a read that waits: a participant's, or a member's reading. */
type Waiter = {
	session: string;
	/** The participant's, where it is a receive; a read is no participant. */
	user: string;
	agent: string;
	reads: boolean;
	login: string;
	name: string;
	wake: Wake;
	own: boolean;
	after: number;
	end: (outcome: Found | Refused, presence?: Presence) => void;
};

/**
 * What a waiter found: the entries for it, and the last entry they cover, its own included, and
 * the messages of other sessions that name it.
 */
type Found = {
	entries: EntryRow[];
	covered: number;
	mentions: MentionRow[];
	/** Which of the entries ping it, for a receive. */
	pinging: (row: EntryRow) => boolean;
};

type MentionRow = EntryRow & {
	id: number;
	session: string;
	sessionName: string;
	pinged: number;
};

const waiting = new Set<Waiter>();

/** When each agent's last receive started or ended, keyed by `keyOf`. */
const lastReceived = new Map<
	string,
	{ user: string; agent: string; time: number }
>();

function keyOf(user: string, agent: string): string {
	return JSON.stringify([user, agent]);
}

/** Whether the agent is online: a receive of its waits, or ended moments ago. */
function isOnline(user: string, agent: string): boolean {
	const last = lastReceived.get(keyOf(user, agent));
	if (last && Date.now() - last.time < onlineFor) return true;
	for (const w of waiting)
		if (!w.reads && w.user === user && w.agent === agent) return true;
	return false;
}

/** Every agent online now, each with the sessions it receives in. */
export function onlineAgents(): {
	user: string;
	agent: string;
	sessions: string[];
}[] {
	const online = new Map<
		string,
		{ user: string; agent: string; sessions: string[] }
	>();
	const now = Date.now();
	for (const [key, { user, agent, time }] of lastReceived)
		if (now - time < onlineFor) online.set(key, { user, agent, sessions: [] });
	for (const w of waiting) {
		if (w.reads || !w.agent) continue;
		const key = keyOf(w.user, w.agent);
		const agent = online.get(key) ?? {
			user: w.user,
			agent: w.agent,
			sessions: [],
		};
		if (!agent.sessions.includes(w.session)) agent.sessions.push(w.session);
		online.set(key, agent);
	}
	return [...online.values()];
}

/**
 * Notes that a receive of the agent started or ended: what shows who is online changes where it
 * comes online now, or once it stays offline.
 */
function received(user: string, agent: string): void {
	if (!agent) return;
	const was = isOnline(user, agent);
	const key = keyOf(user, agent);
	lastReceived.set(key, { user, agent, time: Date.now() });
	if (!was) written();
	setTimeout(() => {
		const last = lastReceived.get(key);
		if (last && Date.now() - last.time >= onlineFor) {
			lastReceived.delete(key);
			if (!isOnline(user, agent)) written();
		}
	}, onlineFor + 100).unref();
}

/**
 * The entries after `after`, the waiter's own left out where it wants them not, about one
 * answer's worth, and for a receive the messages of other sessions that name it.
 */
function entriesFor(
	w: Pick<
		Waiter,
		"session" | "user" | "agent" | "name" | "own" | "reads" | "after"
	>,
): Found {
	const rows = db
		.prepare(
			"SELECT n, time, sender, type, size, filename, text FROM entry WHERE session = ? AND n > ? ORDER BY n LIMIT 1000",
		)
		.all(w.session, w.after) as EntryRow[];
	const entries: EntryRow[] = [];
	let covered = w.after;
	let bytes = 0;
	for (const row of rows) {
		bytes += (row.text?.length ?? 0) + 200;
		if (entries.length && bytes > maxAnswer) break;
		covered = row.n;
		if (!w.reads && !w.own && row.sender === w.name) continue;
		entries.push(row);
	}
	return {
		entries,
		covered,
		mentions: w.reads ? [] : mentionsOf(w),
		pinging: w.reads ? () => false : pingingOf(w),
	};
}

/**
 * Which entries of its session ping a participant: one that names it in its `ping`, until it
 * received it in another session; any other that pings it, such as by `*`, only where it was in
 * the session when it was sent, so that who joins later gets earlier entries, but not as pings.
 */
function pingingOf(
	w: Pick<Waiter, "session" | "user" | "agent" | "name" | "after">,
): (row: EntryRow) => boolean {
	// When it joined and left, from the log: it was in for an entry where its last join or
	// leave before it is a join.
	const turns = db
		.prepare(
			"SELECT n, type FROM entry WHERE session = ? AND sender = ? AND type IN (?, ?) ORDER BY n",
		)
		.all(w.session, w.name, joinType, leaveType) as {
		n: number;
		type: string;
	}[];
	const wasIn = (n: number) =>
		turns.findLast((turn) => turn.n < n)?.type === joinType;
	const named = new Map(
		(
			db
				.prepare(
					"SELECT n, delivered FROM mention WHERE user = ? AND agent = ? AND session = ? AND ping = 1 AND n > ?",
				)
				.all(w.user, w.agent, w.session, w.after) as {
				n: number;
				delivered: number;
			}[]
		).map((row) => [row.n, row.delivered === 1]),
	);
	return (row) => {
		if (!pings(row.type, w.name)) return false;
		const delivered = named.get(row.n);
		return delivered === undefined ? wasIn(row.n) : !delivered;
	};
}

/** The messages of sessions other than the waiter's that name it, which it still sees. */
function mentionsOf(
	w: Pick<Waiter, "session" | "user" | "agent">,
): MentionRow[] {
	const rows = db
		.prepare(
			`SELECT m.id, m.session, m.ping AS pinged, s.name AS sessionName,
			 e.n, e.time, e.sender, e.type, e.size, e.filename, e.text
			 FROM mention m JOIN entry e ON e.session = m.session AND e.n = m.n
			 JOIN session s ON s.id = m.session
			 WHERE m.user = ? AND m.agent = ? AND m.session != ? AND m.delivered = 0
			 ORDER BY m.id LIMIT 100`,
		)
		.all(w.user, w.agent, w.session) as MentionRow[];
	return rows.filter((row) => {
		if (sessionFor(row.session, w.user)) return true;
		db.prepare("DELETE FROM mention WHERE id = ?").run(row.id);
		return false;
	});
}

// A mention not received in its own session for a week goes, delivered elsewhere or not.
setInterval(
	() =>
		db
			.prepare("DELETE FROM mention WHERE created < ?")
			.run(new Date(Date.now() - 7 * 86400_000).toISOString()),
	3600_000,
).unref();

/** Whether `w` has something to return now. */
function ready(w: Waiter, { entries, mentions, pinging }: Found): boolean {
	if (w.reads || w.wake !== "ping")
		return entries.length > 0 || mentions.length > 0;
	return entries.some(pinging) || mentions.some((m) => m.pinged);
}

function answerOf(
	w: Waiter,
	{ entries, mentions, pinging }: Found,
	presence: Presence,
): Answer {
	const own: Received[] = entries.map((row) => ({
		...entryJson(row),
		...(!w.reads && { ping: pinging(row) }),
	}));
	const others: Received[] = mentions.map((row) => ({
		...entryJson(row),
		ping: row.pinged === 1,
		session: { id: row.session, name: row.sessionName },
	}));
	return {
		entries: [...own, ...others].sort((a, b) => a.time.localeCompare(b.time)),
		presence,
	};
}

/**
 * Wakes the waiters of `session` that have something now, or all those that wake for any
 * change where the presence changed. Every one woken at once gets the presence from before
 * any of them ended.
 */
function notify(session: string, presenceChanged: boolean): void {
	const woken: [Waiter, Found][] = [];
	for (const w of waiting) {
		if (w.session !== session) continue;
		const found = entriesFor(w);
		if (ready(w, found) || (presenceChanged && w.wake === "change"))
			woken.push([w, found]);
	}
	if (!woken.length) return;
	const presence = presenceOf(session);
	for (const [w, found] of woken) w.end(found, presence);
}

/** Wakes the receives of `named` in other sessions than `session` that have something now. */
function notifyNamed(
	session: string,
	named: { user: string; agent: string }[],
): void {
	for (const w of [...waiting]) {
		if (w.reads || w.session === session) continue;
		if (!named.some((p) => p.user === w.user && p.agent === w.agent)) continue;
		const found = entriesFor(w);
		if (ready(w, found)) w.end(found, presenceOf(w.session));
	}
}

/** Ends every waiter of `session` that `matches`, with `outcome`. */
function endWaiters(
	session: string,
	matches: (w: Waiter) => boolean,
	outcome: (w: Waiter) => Found | Refused,
): void {
	const presence = presenceOf(session);
	for (const w of [...waiting])
		if (w.session === session && matches(w)) w.end(outcome(w), presence);
}

/** Ends everything waiting on a session that is gone. */
export function sessionGone(session: string): void {
	endWaiters(
		session,
		() => true,
		() => new Refused(404, "No such session."),
	);
}

/** Checks that the caller may still be in `session`, as a member, and holds the participant's name. */
function stillIn(w: Waiter): Refused | undefined {
	if (!lasts(w.user, w.login)) return new Refused(403, "The login is revoked.");
	if (!sessionFor(w.session, w.user))
		return new Refused(403, "You are no longer in this session's group.");
	if (w.reads) return undefined;
	const row = participantRow(w);
	if (!row?.inside) return new Refused(403, "You left the session.");
	if (row.holder !== null && row.holder !== w.login)
		return new Refused(403, "Another login took this name.");
	return undefined;
}

// Every few seconds, so that a revoked login or a member who left is cut off on a receive
// already waiting too.
setInterval(() => {
	for (const w of [...waiting]) {
		const refused = stillIn(w);
		if (refused) w.end(refused);
	}
}, 5000).unref();

/** The participant as `login` acts for it, or why not: joined, and its name held by `login`. */
function inside(p: Participant, login: string): ParticipantRow {
	const row = participantRow(p);
	if (!row?.inside)
		throw new Refused(
			403,
			"Join the session first, or join again after leaving.",
		);
	if (row.holder !== null && row.holder !== login)
		throw new Refused(
			403,
			"Another login took this name: join again to take it back, or take another.",
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

function append(
	session: string,
	sender: string,
	type: string,
	payload: Uint8Array,
	filename: string | null,
): number {
	const n = lastOf(session) + 1;
	const text = inlineText(type, payload);
	db.prepare(
		"INSERT INTO entry (session, n, time, sender, type, size, filename, text, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		session,
		n,
		new Date().toISOString().replace(/\.\d+Z$/, "Z"),
		sender,
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

/**
 * Joins `p` as `login`, or joins again; joining while in does nothing. An agent's name is held
 * by one login at a time: another login takes it once its holder left, was revoked, or has not
 * received for an hour.
 */
export function join(
	p: Participant,
	login: string,
	name: string,
): { n: number; name: string; read: number } {
	const holder = p.agent ? login : null;
	const result = transaction(() => {
		const row = participantRow(p);
		if (row?.inside) {
			if (row.holder === null || row.holder === login)
				return { n: row.entry, read: row.read, took: false };
			const busy = [...waiting].some(
				(w) =>
					!w.reads &&
					w.session === p.session &&
					w.user === p.user &&
					w.agent === p.agent,
			);
			const recent = Date.now() - Date.parse(row.since) < holdFor;
			if (lasts(p.user, row.holder) && (busy || recent))
				throw new Refused(
					409,
					`${name} is held by another login: pick another name, such as ${name}-2.`,
				);
			db.prepare(
				"UPDATE participant SET holder = ? WHERE session = ? AND user = ? AND agent = ?",
			).run(holder, p.session, p.user, p.agent);
			return { n: row.entry, read: row.read, took: true };
		}
		const n = append(p.session, name, joinType, new Uint8Array(), null);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO participant (session, user, agent, inside, entry, read, since, holder)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?)
			 ON CONFLICT DO UPDATE SET inside = 1, entry = excluded.entry, since = excluded.since, holder = excluded.holder`,
		).run(p.session, p.user, p.agent, n, row?.read ?? 0, now, holder);
		return { n, read: row?.read ?? 0, took: false };
	});
	if (result.took)
		endWaiters(
			p.session,
			(w) =>
				!w.reads &&
				w.user === p.user &&
				w.agent === p.agent &&
				w.login !== login,
			() => new Refused(403, "Another login took this name."),
		);
	notify(p.session, true);
	return { n: result.n, name, read: result.read };
}

/** Leaves: the name's receives still waiting return, on every login. */
export function leave(
	p: Participant,
	login: string,
	name: string,
): { n: number } {
	const row = participantRow(p);
	if (row && !row.inside) return { n: row.entry };
	inside(p, login);
	const n = transaction(() => {
		const n = append(p.session, name, leaveType, new Uint8Array(), null);
		db.prepare(
			"UPDATE participant SET inside = 0, entry = ?, holder = NULL, status = NULL, since = ? WHERE session = ? AND user = ? AND agent = ?",
		).run(n, new Date().toISOString(), p.session, p.user, p.agent);
		return n;
	});
	endWaiters(
		p.session,
		(w) => !w.reads && w.user === p.user && w.agent === p.agent,
		entriesFor,
	);
	notify(p.session, true);
	return { n };
}

/**
 * Sends an entry, and returns its number, and the names its `ping` or `fyi` lists that don't see
 * the session. A status sets the sender's status as well.
 */
export function send(
	p: Participant,
	login: string,
	name: string,
	type: string,
	payload: Uint8Array,
	filename: string | null,
): { n: number; unreached?: string[] } {
	inside(p, login);
	if (payload.length > maxPayload)
		throw new Refused(
			413,
			`A payload is at most ${maxPayload / 1024 / 1024} MB.`,
		);
	let status: string | null | undefined;
	if (type.split(";")[0]?.trim().toLowerCase() === statusType) {
		const text = (() => {
			try {
				return JSON.parse(new TextDecoder().decode(payload))?.text;
			} catch {
				return undefined;
			}
		})();
		if (typeof text !== "string")
			throw new Refused(400, 'A status is {"text": "<one sentence>"}.');
		status = text.trim().slice(0, 500) || null;
	}
	adds(p.user, payload.length);
	const { n, noted, unreached } = transaction(() => {
		const n = append(p.session, name, type, payload, filename);
		if (status !== undefined)
			db.prepare(
				"UPDATE participant SET status = ? WHERE session = ? AND user = ? AND agent = ?",
			).run(status, p.session, p.user, p.agent);
		return { n, ...mention(p.session, n, name, type) };
	});
	notify(p.session, status !== undefined);
	notifyNamed(p.session, noted);
	return { n, ...(unreached.length && { unreached }) };
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
	const { noted } = transaction(() => {
		const n = append(
			session,
			systemName,
			type,
			new TextEncoder().encode(text),
			null,
		);
		return mention(session, n, systemName, type);
	});
	notify(session, false);
	notifyNamed(session, noted);
}

/**
 * Receives what others sent after the read position, or after `after`, and acknowledges what it
 * covers as it returns. It waits until something wakes it, or `wait` seconds are over.
 * One receive per participant and login at a time: a newer one ends the one before with 409.
 */
export function receive(
	p: Participant,
	login: string,
	name: string,
	options: { after?: number; wait?: number; wake: Wake; own: boolean },
	signal: AbortSignal,
): Promise<Answer> {
	const row = inside(p, login);
	endWaiters(
		p.session,
		(w) =>
			!w.reads && w.user === p.user && w.agent === p.agent && w.login === login,
		() =>
			new Refused(
				409,
				"A newer receive of the same participant replaced this one.",
			),
	);
	const after = Math.min(options.after ?? row.read, lastOf(p.session));
	seen(p, after);
	received(p.user, p.agent);
	return wait(
		{
			session: p.session,
			user: p.user,
			agent: p.agent,
			reads: false,
			login,
			name,
			wake: options.wake,
			own: options.own,
			after,
		},
		options.wait,
		signal,
	);
}

/** Reads the log without joining: every entry after `after`, waiting up to `wait` seconds for one. */
export function read(
	session: string,
	user: string,
	login: string,
	options: { after: number; wait: number },
	signal: AbortSignal,
): Promise<Answer> {
	return wait(
		{
			session,
			user,
			agent: "",
			reads: true,
			login,
			name: "",
			wake: "entry",
			own: true,
			after: options.after,
		},
		options.wait,
		signal,
	);
}

function wait(
	w: Omit<Waiter, "end">,
	seconds: number | undefined,
	signal: AbortSignal,
): Promise<Answer> {
	const waiter = w as Waiter;
	const found = entriesFor(waiter);
	if (ready(waiter, found) || seconds === 0)
		return Promise.resolve(finish(waiter, found, presenceOf(w.session), false));
	if (
		[...waiting].filter((other) => other.user === w.user).length >=
		limits.waiting
	)
		return Promise.reject(
			new Refused(503, "This account has too many receives waiting.", 10),
		);
	// Whether a receive is waiting is presence; one that wakes for any change, such as a
	// page's, changes nothing for others, so that two of them don't wake each other forever.
	const counted = !waiter.reads && waiter.wake !== "change";
	return new Promise<Answer>((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		const stop = (): boolean => {
			if (!waiting.delete(waiter)) return false;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (!waiter.reads) received(waiter.user, waiter.agent);
			return true;
		};
		waiter.end = (outcome, presence) => {
			if (!stop()) return;
			if (outcome instanceof Refused) {
				reject(outcome);
				if (counted) notify(w.session, true);
			} else
				resolve(
					finish(waiter, outcome, presence ?? presenceOf(w.session), counted),
				);
		};
		const abort = () => {
			if (!stop()) return;
			reject(new Refused(400, "The receive was cut off."));
			if (waiter.reads) return;
			db.prepare(
				"UPDATE participant SET since = ? WHERE session = ? AND user = ? AND agent = ?",
			).run(new Date().toISOString(), w.session, w.user, w.agent);
			if (counted) notify(w.session, true);
		};
		waiting.add(waiter);
		signal.addEventListener("abort", abort);
		if (seconds !== undefined)
			timer = setTimeout(() => waiter.end(entriesFor(waiter)), seconds * 1000);
		if (counted) notify(w.session, true);
	});
}

/**
 * The participant has received its session up to `n`: what named it there up to it no longer
 * marks the session as pinging it.
 */
function seen(p: Participant, n: number): void {
	const gone = db
		.prepare(
			"DELETE FROM mention WHERE user = ? AND agent = ? AND session = ? AND n <= ?",
		)
		.run(p.user, p.agent, p.session, n).changes;
	if (gone) written();
}

/**
 * A receive that returns acknowledges what it covers, and ends its receiving: the presence
 * changes where its read position moved, or where it counted as receiving.
 */
function finish(
	w: Waiter,
	found: Found,
	presence: Presence,
	wasReceiving: boolean,
): Answer {
	const answer = answerOf(w, found, presence);
	if (w.reads) return answer;
	// The messages that named it are received: those of other sessions it got here, and those of
	// this one that this receive covers, which also no longer mark this session as pinging it.
	for (const m of found.mentions)
		db.prepare("UPDATE mention SET delivered = 1 WHERE id = ?").run(m.id);
	seen(w, found.covered);
	const moved = db
		.prepare(
			"UPDATE participant SET read = ? WHERE session = ? AND user = ? AND agent = ? AND read < ?",
		)
		.run(found.covered, w.session, w.user, w.agent, found.covered).changes;
	db.prepare(
		"UPDATE participant SET since = ? WHERE session = ? AND user = ? AND agent = ?",
	).run(new Date().toISOString(), w.session, w.user, w.agent);
	if (moved || wasReceiving) queueMicrotask(() => notify(w.session, true));
	return answer;
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
