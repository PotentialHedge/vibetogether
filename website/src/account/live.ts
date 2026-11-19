/** A session as the page observes it, and the person's own stream, which the
 * page receives while it is open: the same operations every client makes. */

import { client, clientOf, others } from "@/account/api";
import type { Entry, Participant } from "@/client/vibetogether_client";

export type { Entry };

/** Everyone in a session, by name. */
export type Participants = Record<string, Participant>;

export const JOIN = "application/vnd.vibetogether.join";
export const LEAVE = "application/vnd.vibetogether.leave";

/** Whether a call was refused, rather than failed on the way. */
const refused = (error: unknown) => {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" && status < 500;
};

const backoff = (failures: number) =>
	new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));

export type Subscriber = {
	entry: () => void;
	participants: (participants: Participants) => void;
	/** The page stopped observing, with why. */
	end: (why: string) => void;
};

/** The person in a session: its log so far, and who is in it, kept current
 * while the page observes it. */
export class Seat {
	log: Entry[] = [];
	participants: Participants = {};
	#session: string;
	#subscribers = new Set<Subscriber>();
	#stop: AbortController | null = null;

	constructor(session: string) {
		this.#session = session;
	}

	/** Joins, or does nothing where the person is in already. */
	async join(): Promise<void> {
		await (await clientOf(this.#session)).join(this.#session);
	}

	/** Sends, and returns the names its `ping` or `fyi` lists that don't see
	 * the session, so are reached by nothing. */
	async send(text: string, type: string): Promise<string[]> {
		const sent = await (await clientOf(this.#session)).send(
			this.#session,
			type,
			new TextEncoder().encode(text),
		);
		return sent.unreached ?? [];
	}

	/** Entry `n`'s payload. */
	async payload(n: number): Promise<Blob> {
		return (await clientOf(this.#session)).fetch(this.#session, n);
	}

	subscribe(subscriber: Subscriber): () => void {
		this.#subscribers.add(subscriber);
		return () => this.#subscribers.delete(subscriber);
	}

	/** Observes the session: reads the log so far, then waits for each change
	 * of it or of who is in it, while the page is open. */
	async start(): Promise<void> {
		this.close();
		const stop = new AbortController();
		this.#stop = stop;
		let revision: string | undefined;
		let failures = 0;
		while (!stop.signal.aborted) {
			const after = this.log.at(-1)?.n ?? 0;
			try {
				const log = await (await clientOf(this.#session)).log(
					this.#session,
					revision === undefined ? { after } : { after, revision },
					stop.signal,
				);
				failures = 0;
				revision = log.revision;
				if (log.entries.length) {
					this.log = [...this.log, ...log.entries];
					for (const s of this.#subscribers) s.entry();
				}
				this.participants = log.participants;
				for (const s of this.#subscribers) s.participants(log.participants);
			} catch (error) {
				if (stop.signal.aborted) return;
				// A refusal: this one stops until the page is used again.
				if (refused(error)) {
					for (const s of this.#subscribers) s.end((error as Error).message);
					return;
				}
				failures += 1;
				await backoff(failures);
			}
		}
	}

	close(): void {
		this.#stop?.abort();
		this.#stop = null;
	}
}

/** The person's own stream on one server, received while the page is open,
 * which shows them awake while they look at it and asleep otherwise: its
 * unread items, by their session, and its positions, once the first answer
 * gave them. Each of the person's servers has its own. */
type Stream = {
	unread: { n: number; session: string }[];
	received: number | undefined;
	read: number;
	/** The state the waiting receive holds. */
	state: "awake" | "asleep";
	/** Whether the waiting receive holds do not disturb. */
	dnd: boolean;
	/** The receive waiting, which a change of `read` or the state issues again. */
	request: AbortController | null;
};

/** Each server's stream, by its host, the home one's as "". */
const streams = new Map<string, Stream>();
/** The session open and visible, whose items are read. */
let shown: string | null = null;

/** Awake while the person looks at the page: it is visible and has focus, as
 * an agent is awake while a turn runs; asleep while it is open but not looked
 * at, Luis's decision (2026-11-16). */
const stateNow = () =>
	document.visibilityState === "visible" && document.hasFocus()
		? "awake"
		: "asleep";

/** The highest item with every one before it read: the unread ones of the
 * session shown go. */
function readNow(stream: Stream): number {
	const open = document.visibilityState === "visible" ? shown : null;
	stream.unread = stream.unread.filter((item) => item.session !== open);
	return (stream.unread[0]?.n ?? (stream.received ?? 0) + 1) - 1;
}

/** Do not disturb, as the person chose it, remembered per browser: the
 * page's receive holds it, so others see that a mention won't reach them now,
 * Luis's decision (2026-11-16). */
const dndKey = "do-not-disturb";
let dndChosen = (() => {
	try {
		return localStorage.getItem(dndKey) === "on";
	} catch {
		return false;
	}
})();

export function doNotDisturb(): boolean {
	return dndChosen;
}

export function setDoNotDisturb(on: boolean) {
	try {
		if (on) localStorage.setItem(dndKey, "on");
		else localStorage.removeItem(dndKey);
	} catch {}
	dndChosen = on;
	reread();
}

/** Issues each receive again where its read position, the state or do not
 * disturb moved. */
function reread() {
	for (const stream of streams.values())
		if (
			stream.received !== undefined &&
			(readNow(stream) !== stream.read ||
				stateNow() !== stream.state ||
				dndChosen !== stream.dnd)
		)
			stream.request?.abort();
}

async function receiving(
	stream: Stream,
	client: Awaited<ReturnType<typeof clientOf>>,
) {
	let failures = 0;
	for (;;) {
		const request = new AbortController();
		stream.request = request;
		// The first receive gets every unread item.
		if (stream.received !== undefined) stream.read = readNow(stream);
		stream.state = stateNow();
		stream.dnd = dndChosen;
		const { state, dnd } = stream;
		try {
			const answer = await client.receive(
				stream.received === undefined
					? { received: 0, state, dnd }
					: { received: stream.received, read: stream.read, state, dnd },
				request.signal,
			);
			failures = 0;
			stream.unread.push(
				...answer.items.map((item) => ({
					n: item.n,
					session: item.session.id,
				})),
			);
			stream.received = Math.max(answer.received, answer.items.at(-1)?.n ?? 0);
		} catch (error) {
			if (request.signal.aborted) continue;
			if (refused(error)) return;
			failures += 1;
			await backoff(failures);
		}
	}
}

/** Starts receiving on each of the person's servers that isn't yet. */
async function receiveEverywhere() {
	const servers: [string, Awaited<ReturnType<typeof clientOf>>][] = [
		["", await client()],
		...(await others()).map(({ host, client }): [string, typeof client] => [
			host,
			client,
		]),
	];
	for (const [host, client] of servers) {
		if (streams.has(host)) continue;
		const stream: Stream = {
			unread: [],
			received: undefined,
			read: 0,
			state: "awake",
			dnd: false,
			request: null,
		};
		streams.set(host, stream);
		receiving(stream, client);
	}
}

let listening = false;

/** Shows the session `id` in the page, or none: while the page is visible,
 * its items in the person's stream are read. The first call starts receiving
 * the streams, and each call starts any server's that was added since. */
export function showSession(id: string | null) {
	if (!listening) {
		listening = true;
		document.addEventListener("visibilitychange", reread);
		addEventListener("focus", reread);
		addEventListener("blur", reread);
	}
	receiveEverywhere();
	shown = id;
	reread();
}
