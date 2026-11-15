/**
 * The transport: each session's log, its participants, each agent's stream, and the receives
 * waiting. An agent receives its stream, which holds everything that reaches it; a person's page
 * receives its session. Everything waiting is in memory, everything else in the database, so a
 * restart ends the waiting receives, which their clients make again.
 */
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { lasts } from "./caller.ts";
import { written } from "./changes.ts";
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

/** The state an agent's receive holds, set by its own side: whether it is in a turn. */
export type State = "awake" | "asleep";

/**
 * A participant's presence, by how soon it acts again: `awake` or `asleep`, as its receive holds,
 * while one waits or ended moments ago, `offline` otherwise. A person's page holds `awake`.
 */
export type PresenceState = State | "offline";

export type Presence = Record<
	string,
	{
		id: string;
		read: number;
		presence: PresenceState;
		since?: string;
		status?: string;
	}
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
function namesOf(type: string, parameter: string): string[] {
	return (parameterOf(type, parameter) ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Whether `entry` pings `name`: a `ping` parameter names whom it pings, or `*` everyone; left
 * out, a message pings everyone, and an entry of an extension, of a `vnd.` type, no one.
 */
export function pings(type: string, name: string): boolean {
	return pingsEveryone(type) || namesOf(type, "ping").includes(name);
}

/** Whether `entry` pings everyone in its session: its `ping` is `*`, or left out of a message. */
function pingsEveryone(type: string): boolean {
	if (parameterOf(type, "ping") === undefined) return isMessage(type);
	return namesOf(type, "ping").includes("*");
}

/** The most names one message lists in its `ping` and `fyi` together. */
const maxNamed = 32;

/** Why an item reached an agent: it names it in `ping`, or in `fyi`, or was said in a session it listens to. */
export type Reach = "ping" | "fyi" | "session";

/**
 * Delivers entry `n` of `session`, from the participant `sender`, null for Vibe Together's own.
 * A message reaches every name its `ping` or `fyi` lists, as the name stands as it is sent, where
 * it sees the session, and for an explicit `*` every participant in the session, as a ping; any
 * entry reaches every agent in the session, the sender left out. An agent gets an item of its
 * stream, and a person named a mention. Returns the persons and agents reached, and the names that
 * see the session not.
 */
function deliver(
	session: string,
	n: number,
	sender: string | null,
	type: string,
): {
	people: { user: string; id: string }[];
	agents: string[];
	unreached: string[];
} {
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
			row.id !== row.user &&
			row.id !== sender &&
			!reached.has(row.id) &&
			sessionFor(session, row.user)
		)
			reached.set(row.id, { user: row.user, reach: "session" });
	const now = new Date().toISOString();
	const people: { user: string; id: string }[] = [];
	const agents: string[] = [];
	for (const [id, { user, reach }] of reached) {
		if (id === user) {
			if (reach === "session") continue;
			db.prepare(
				"INSERT INTO mention (participant, user, session, n, ping, created) VALUES (?, ?, ?, ?, ?, ?)",
			).run(id, user, session, n, reach === "ping" ? 1 : 0, now);
			people.push({ user, id });
			continue;
		}
		const { last } = db
			.prepare(
				`INSERT INTO stream_head (agent, last, position) VALUES (?, 1, 0)
				 ON CONFLICT DO UPDATE SET last = last + 1 RETURNING last`,
			)
			.get(id) as { last: number };
		db.prepare(
			"INSERT INTO stream (agent, n, session, entry, reach, created) VALUES (?, ?, ?, ?, ?, ?)",
		).run(id, last, session, n, reach, now);
		agents.push(id);
	}
	return { people, agents, unreached };
}

/** Who is in the session, with their read position, their presence, and their status. */
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
			read: row.read,
			presence: state,
			...(state === "offline" && { since: row.since }),
			...(row.text !== null && { status: row.text }),
		};
	}
	return presence;
}

/** A person's page receiving its session, or a member reading a session. */
type Waiter = {
	session: string;
	/** The person, where it is a receive; a read is no participant. */
	user: string;
	id: string;
	reads: boolean;
	login: string;
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

/** An agent's receive waiting on its stream, with the state it holds. */
type StreamWaiter = {
	user: string;
	id: string;
	login: string;
	state: State;
	/** Returns what is after the read position now, or the refusal. */
	end: (refused?: Refused) => void;
};

/** The one receive of each agent waiting, by its id. */
const streams = new Map<string, StreamWaiter>();

/** When each participant's last receive started or ended, by its id, and the state it held. */
const lastReceived = new Map<
	string,
	{ user: string; time: number; state: State }
>();

/**
 * A participant's presence: the state its receive holds while one waits, or ended moments ago,
 * `offline` otherwise. A person's page is `awake`.
 */
export function presenceOfParticipant(id: string): PresenceState {
	const stream = streams.get(id);
	if (stream) return stream.state;
	for (const w of waiting) if (!w.reads && w.id === id) return "awake";
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
	for (const w of waiting) if (!w.reads) ids.set(w.id, w.user);
	for (const w of streams.values()) ids.set(w.id, w.user);
	return [...ids].flatMap(([id, user]) => {
		const presence = presenceOfParticipant(id);
		return presence === "offline" ? [] : [{ user, id, presence }];
	});
}

/**
 * Makes `change` to what the participant's presence comes from: where the presence changes, the
 * pages that show it and the overviews that wait are woken.
 */
function presenceChange(id: string, change: () => void): void {
	const was = presenceOfParticipant(id);
	change();
	if (presenceOfParticipant(id) !== was) presenceMoved(id);
}

/** Wakes what shows the participant's presence: its sessions' pages, and the overviews that wait. */
function presenceMoved(id: string): void {
	written();
	queueMicrotask(() => {
		for (const { session } of db
			.prepare("SELECT session FROM participant WHERE id = ? AND inside = 1")
			.all(id) as { session: string }[])
			notify(session, true);
	});
}

/**
 * Notes that a receive of the participant started or ended, holding `state`: it stays awake or
 * asleep moments longer, so that receiving again keeps it, and goes offline after.
 */
function received(user: string, id: string, state: State): void {
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
			if (presenceOfParticipant(id) === "offline") presenceMoved(id);
		}
	}, graceFor + 100).unref();
}

/** Notes when the participant's receive ended, which its sessions show while it is offline. */
function ended(id: string): void {
	db.prepare("UPDATE participant SET since = ? WHERE id = ?").run(
		new Date().toISOString(),
		id,
	);
}

/**
 * The entries after `after`, the waiter's own left out where it wants them not, about one
 * answer's worth, and for a receive the messages of other sessions that name it.
 */
function entriesFor(
	w: Pick<Waiter, "session" | "user" | "id" | "own" | "reads" | "after">,
): Found {
	const rows = db
		.prepare(
			"SELECT n, time, sender, participant, type, size, filename, text FROM entry WHERE session = ? AND n > ? ORDER BY n LIMIT 1000",
		)
		.all(w.session, w.after) as EntryRow[];
	const entries: EntryRow[] = [];
	let covered = w.after;
	let bytes = 0;
	for (const row of rows) {
		bytes += (row.text?.length ?? 0) + 200;
		if (entries.length && bytes > maxAnswer) break;
		covered = row.n;
		if (!w.reads && !w.own && row.participant === w.id) continue;
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
 * received it in another session; one that pings everyone, only where it was in the session when
 * it was sent, so that who joins later gets earlier entries, but not as pings.
 */
function pingingOf(
	w: Pick<Waiter, "session" | "id" | "after">,
): (row: EntryRow) => boolean {
	// It is in since its last join, where it is in; for an entry before that, whether it was in
	// comes from its joins and leaves in the log, read only where needed.
	const row = participantRow(w);
	const since = row?.inside ? row.entry : Number.POSITIVE_INFINITY;
	let turns: { n: number; type: string }[] | undefined;
	const wasIn = (n: number) => {
		if (n > since) return true;
		turns ??= db
			.prepare(
				"SELECT n, type FROM entry WHERE session = ? AND participant = ? AND type IN (?, ?) ORDER BY n",
			)
			.all(w.session, w.id, joinType, leaveType) as {
			n: number;
			type: string;
		}[];
		return turns.findLast((turn) => turn.n < n)?.type === joinType;
	};
	// Whom a name stood for was decided as it was sent, so a rename since changes nothing.
	const named = new Map(
		(
			db
				.prepare(
					"SELECT n, delivered FROM mention WHERE participant = ? AND session = ? AND ping = 1 AND n > ?",
				)
				.all(w.id, w.session, w.after) as {
				n: number;
				delivered: number;
			}[]
		).map((row) => [row.n, row.delivered === 1]),
	);
	return (row) => {
		const delivered = named.get(row.n);
		if (delivered !== undefined) return !delivered;
		return pingsEveryone(row.type) && wasIn(row.n);
	};
}

/** The messages of sessions other than the waiter's that name it, which it still sees. */
function mentionsOf(w: Pick<Waiter, "session" | "user" | "id">): MentionRow[] {
	const rows = db
		.prepare(
			`SELECT m.id, m.session, m.ping AS pinged, s.name AS sessionName,
			 e.n, e.time, e.sender, e.participant, e.type, e.size, e.filename, e.text
			 FROM mention m JOIN entry e ON e.session = m.session AND e.n = m.n
			 JOIN session s ON s.id = m.session
			 WHERE m.participant = ? AND m.session != ? AND m.delivered = 0
			 ORDER BY m.id LIMIT 100`,
		)
		.all(w.id, w.session) as MentionRow[];
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
function notifyNamed(session: string, named: { id: string }[]): void {
	for (const w of [...waiting]) {
		if (w.reads || w.session === session) continue;
		if (!named.some((p) => p.id === w.id)) continue;
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

/** Checks that the person may still be in `session`, as a member, and is in it where it receives. */
function stillIn(w: Waiter): Refused | undefined {
	if (!lasts(w.user, w.login)) return new Refused(403, "The login is revoked.");
	if (!sessionFor(w.session, w.user))
		return new Refused(403, "You are no longer in this session's group.");
	if (w.reads) return undefined;
	if (!participantRow(w)?.inside)
		return new Refused(403, "You left the session.");
	return undefined;
}

/** Checks that the agent's login lasts and still holds it, and that it is not archived. */
function stillHolds(w: StreamWaiter): Refused | undefined {
	if (!lasts(w.user, w.login)) return new Refused(403, "The login is revoked.");
	const agent = db
		.prepare("SELECT holder, archived FROM agent WHERE id = ?")
		.get(w.id) as { holder: string | null; archived: string | null };
	if (agent.archived) return new Refused(403, "The agent is archived.");
	if (agent.holder !== w.login)
		return new Refused(403, "Another login took this agent.");
	return undefined;
}

// Every few seconds, so that a revoked login or a member who left is cut off on a receive
// already waiting too.
setInterval(() => {
	for (const w of [...waiting]) {
		const refused = stillIn(w);
		if (refused) w.end(refused);
	}
	for (const w of [...streams.values()]) {
		const refused = stillHolds(w);
		if (refused) w.end(refused);
	}
}, 5000).unref();

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
		const busy = streams.has(id);
		const recent =
			agent.seen !== null && Date.now() - Date.parse(agent.seen) < holdFor;
		if (lasts(user, agent.holder as string) && (busy || recent))
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
	const stream = streams.get(id);
	if (other && stream && stream.login !== login)
		stream.end(new Refused(403, "Another login took this agent."));
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

/** Refuses another receive of the account where it has too many waiting. */
function mayWait(user: string): void {
	const held =
		[...waiting].filter((w) => w.user === user).length +
		[...streams.values()].filter((w) => w.user === user).length;
	if (held >= limits.waiting)
		throw new Refused(503, "This account has too many receives waiting.", 10);
}

/** Wakes what an entry of `session` reached: the session's pages, the persons it named, and the agents. */
function reach(
	session: string,
	{ people, agents }: { people: { id: string }[]; agents: string[] },
	presenceChanged = false,
): void {
	notify(session, presenceChanged);
	notifyNamed(session, people);
	for (const id of agents) streams.get(id)?.end();
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

/** Joins `p` as `login`, under `name`, or joins again; joining while in does nothing. */
export function join(
	p: Participant,
	login: string,
	name: string,
): { n: number; name: string; read: number } {
	hold(p.user, p.id, login);
	const result = transaction(() => {
		const row = participantRow(p);
		if (row?.inside) return { n: row.entry, read: row.read };
		const n = append(
			p.session,
			{ name, id: p.id },
			joinType,
			new Uint8Array(),
			null,
		);
		db.prepare(
			`INSERT INTO participant (session, id, user, inside, entry, read, since)
			 VALUES (?, ?, ?, 1, ?, ?, ?)
			 ON CONFLICT DO UPDATE SET inside = 1, entry = excluded.entry, since = excluded.since`,
		).run(p.session, p.id, p.user, n, row?.read ?? 0, new Date().toISOString());
		return {
			n,
			read: row?.read ?? 0,
			reached: deliver(p.session, n, p.id, joinType),
		};
	});
	if ("reached" in result) reach(p.session, result.reached, true);
	return { n: result.n, name, read: result.read };
}

/** Leaves: the participant's receives still waiting there return, on every login. */
export function leave(
	p: Participant,
	login: string,
	name: string,
): { n: number } {
	const row = participantRow(p);
	if (row && !row.inside) return { n: row.entry };
	hold(p.user, p.id, login);
	inside(p);
	return leaveAs(p, name);
}

function leaveAs(p: Participant, name: string): { n: number } {
	const { n, reached } = transaction(() => {
		const n = append(
			p.session,
			{ name, id: p.id },
			leaveType,
			new Uint8Array(),
			null,
		);
		db.prepare(
			"UPDATE participant SET inside = 0, entry = ?, since = ? WHERE session = ? AND id = ?",
		).run(n, new Date().toISOString(), p.session, p.id);
		return { n, reached: deliver(p.session, n, p.id, leaveType) };
	});
	endWaiters(p.session, (w) => !w.reads && w.id === p.id, entriesFor);
	reach(p.session, reached, true);
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
	const { n, reached } = transaction(() => {
		const n = append(p.session, { name, id: p.id }, type, payload, filename);
		return { n, reached: deliver(p.session, n, p.id, type) };
	});
	reach(p.session, reached);
	const { unreached } = reached;
	return { n, ...(unreached.length && { unreached }) };
}

/** Shows a change to the participant, such as to its name or status, in every session it is in. */
export function participantChanged(id: string): void {
	for (const { session } of db
		.prepare("SELECT session FROM participant WHERE id = ? AND inside = 1")
		.all(id) as { session: string }[])
		notify(session, true);
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
		db.prepare("DELETE FROM stream WHERE agent = ?").run(id);
		db.prepare("DELETE FROM stream_head WHERE agent = ?").run(id);
	});
	streams.get(id)?.end(new Refused(403, "The agent is archived."));
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
	const reached = transaction(() => {
		const n = append(
			session,
			{ name: systemName, id: null },
			type,
			new TextEncoder().encode(text),
			null,
		);
		return deliver(session, n, null, type);
	});
	reach(session, reached);
}

/**
 * A person's page receives its session: what others sent after the read position, or after
 * `after`, which it acknowledges as it returns, and the messages of other sessions that name the
 * person. It waits until something wakes it, or `wait` seconds are over, and holds the person
 * awake meanwhile. One receive per session and login at a time: a newer one ends the one before
 * with 409. An agent receives its stream instead (`receive`).
 */
export function receiveSession(
	p: Participant,
	login: string,
	options: { after?: number; wait?: number; wake: Wake; own: boolean },
	signal: AbortSignal,
): Promise<Answer> {
	const row = inside(p);
	endWaiters(
		p.session,
		(w) => !w.reads && w.id === p.id && w.login === login,
		() =>
			new Refused(
				409,
				"A newer receive of the same participant replaced this one.",
			),
	);
	const after = Math.min(options.after ?? row.read, lastOf(p.session));
	seen(p, after);
	presenceChange(p.id, () => received(p.user, p.id, "awake"));
	return wait(
		{
			session: p.session,
			user: p.user,
			id: p.id,
			reads: false,
			login,
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
			id: "",
			reads: true,
			login,
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
		return Promise.resolve(finish(waiter, found, presenceOf(w.session)));
	try {
		mayWait(w.user);
	} catch (error) {
		return Promise.reject(error);
	}
	// A receive holds its person awake while it waits; a read is no presence.
	const held = (change: () => void) =>
		waiter.reads ? change() : presenceChange(waiter.id, change);
	return new Promise<Answer>((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		const stop = (): boolean => {
			if (!waiting.has(waiter)) return false;
			held(() => {
				waiting.delete(waiter);
				if (!waiter.reads) received(waiter.user, waiter.id, "awake");
			});
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (!waiter.reads) ended(waiter.id);
			return true;
		};
		waiter.end = (outcome, presence) => {
			if (!stop()) return;
			if (outcome instanceof Refused) reject(outcome);
			else resolve(finish(waiter, outcome, presence ?? presenceOf(w.session)));
		};
		const abort = () => {
			if (!stop()) return;
			reject(new Refused(400, "The receive was cut off."));
		};
		held(() => waiting.add(waiter));
		signal.addEventListener("abort", abort);
		if (seconds !== undefined)
			timer = setTimeout(() => waiter.end(entriesFor(waiter)), seconds * 1000);
	});
}

/**
 * The person has received its session up to `n`: what named them there up to it no longer
 * marks the session as pinging them.
 */
function seen(p: Pick<Participant, "session" | "id">, n: number): void {
	const gone = db
		.prepare(
			"DELETE FROM mention WHERE participant = ? AND session = ? AND n <= ?",
		)
		.run(p.id, p.session, n).changes;
	if (gone) written();
}

/** A receive that returns acknowledges what it covers: its read position moves, which its session shows. */
function finish(w: Waiter, found: Found, presence: Presence): Answer {
	const answer = answerOf(w, found, presence);
	if (w.reads) return answer;
	// The messages that named it are received: those of other sessions it got here, and those of
	// this one that this receive covers, which also no longer mark this session as pinging it.
	for (const m of found.mentions)
		db.prepare("UPDATE mention SET delivered = 1 WHERE id = ?").run(m.id);
	seen(w, found.covered);
	const moved = db
		.prepare(
			"UPDATE participant SET read = ? WHERE session = ? AND id = ? AND read < ?",
		)
		.run(found.covered, w.session, w.id, found.covered).changes;
	if (moved) queueMicrotask(() => notify(w.session, true));
	return answer;
}

/** An item of an agent's stream, as its receive answers it. */
export type Item = {
	n: number;
	reach: Reach;
	session: { id: string; name: string };
	entry: Entry;
};

export type StreamAnswer = { items: Item[]; position: number };

type ItemRow = EntryRow & {
	item: number;
	reach: Reach;
	session: string;
	sessionName: string;
};

/**
 * Moves the agent's read position in its stream to `position`, at most its last item, and never
 * back: it acknowledges every item up to it, which go, and moves its read position in each of
 * their sessions to the last entry acknowledged there. Returns the read position now.
 */
function acknowledge(id: string, position: number | undefined): number {
	const head = (db
		.prepare("SELECT last, position FROM stream_head WHERE agent = ?")
		.get(id) as { last: number; position: number } | undefined) ?? {
		last: 0,
		position: 0,
	};
	if (position === undefined) return head.position;
	const to = Math.min(position, head.last);
	if (to <= head.position) return head.position;
	const moved = transaction(() => {
		const reads = db
			.prepare(
				"SELECT session, max(entry) AS entry FROM stream WHERE agent = ? AND n > ? AND n <= ? GROUP BY session",
			)
			.all(id, head.position, to) as { session: string; entry: number }[];
		db.prepare("DELETE FROM stream WHERE agent = ? AND n <= ?").run(id, to);
		db.prepare("UPDATE stream_head SET position = ? WHERE agent = ?").run(
			to,
			id,
		);
		return reads.filter(
			({ session, entry }) =>
				db
					.prepare(
						"UPDATE participant SET read = ? WHERE session = ? AND id = ? AND read < ?",
					)
					.run(entry, session, id, entry).changes > 0,
		);
	});
	for (const { session } of moved) notify(session, true);
	return to;
}

/**
 * The agent's items after `position`, about one answer's worth: those of a session it sees no
 * longer go.
 */
function itemsOf(user: string, id: string, position: number): Item[] {
	const rows = db
		.prepare(
			`SELECT st.n AS item, st.reach, st.session, s.name AS sessionName,
			 e.n, e.time, e.sender, e.participant, e.type, e.size, e.filename, e.text
			 FROM stream st JOIN entry e ON e.session = st.session AND e.n = st.entry
			 JOIN session s ON s.id = st.session
			 WHERE st.agent = ? AND st.n > ? ORDER BY st.n LIMIT 1000`,
		)
		.all(id, position) as ItemRow[];
	const sees = new Map<string, string | undefined>();
	const items: Item[] = [];
	let bytes = 0;
	for (const row of rows) {
		if (!sees.has(row.session))
			sees.set(row.session, sessionFor(row.session, user)?.name);
		const name = sees.get(row.session);
		if (name === undefined) {
			db.prepare("DELETE FROM stream WHERE agent = ? AND n = ?").run(
				id,
				row.item,
			);
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
	return items;
}

// An item unacknowledged for a week goes.
setInterval(
	() =>
		db
			.prepare("DELETE FROM stream WHERE created < ?")
			.run(new Date(Date.now() - 7 * 86400_000).toISOString()),
	3600_000,
).unref();

/**
 * An agent receives its stream: everything that reached it after its read position, as `position`
 * names it, or as it is stored. Naming the position acknowledges every item up to it. It returns
 * as soon as there is an item, or after `wait` seconds, and holds the agent's `state` meanwhile:
 * it is awake or asleep while its receive waits, or ended moments ago. One receive per agent at a
 * time: a newer one ends the one before with 409.
 */
export function receive(
	user: string,
	id: string,
	login: string,
	options: { position?: number; wait?: number; state: State },
	signal: AbortSignal,
): Promise<StreamAnswer> {
	hold(user, id, login);
	streams
		.get(id)
		?.end(
			new Refused(409, "A newer receive of the same agent replaced this one."),
		);
	const position = acknowledge(id, options.position);
	presenceChange(id, () => received(user, id, options.state));
	const items = itemsOf(user, id, position);
	if (items.length || options.wait === 0)
		return Promise.resolve({ items, position });
	try {
		mayWait(user);
	} catch (error) {
		return Promise.reject(error);
	}
	return new Promise<StreamAnswer>((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		const waiter: StreamWaiter = {
			user,
			id,
			login,
			state: options.state,
			end: (refused) => {
				if (!stop()) return;
				if (refused) reject(refused);
				else resolve({ items: itemsOf(user, id, position), position });
			},
		};
		const stop = (): boolean => {
			if (streams.get(id) !== waiter) return false;
			presenceChange(id, () => {
				streams.delete(id);
				received(user, id, options.state);
			});
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			ended(id);
			return true;
		};
		const abort = () => {
			if (stop()) reject(new Refused(400, "The receive was cut off."));
		};
		presenceChange(id, () => streams.set(id, waiter));
		signal.addEventListener("abort", abort);
		const { wait } = options;
		if (wait !== undefined) timer = setTimeout(() => waiter.end(), wait * 1000);
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
