/** A session as the page observes it, and the person's own stream, which the
 * page receives while it is open: the same operations every client makes. */

import { client } from "@/account/api";
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
		await (await client()).join(this.#session);
	}

	/** Sends, and returns the names its `ping` or `fyi` lists that don't see
	 * the session, so are reached by nothing. */
	async send(text: string, type: string): Promise<string[]> {
		const sent = await (await client()).send(
			this.#session,
			type,
			new TextEncoder().encode(text),
		);
		return sent.unreached ?? [];
	}

	/** Entry `n`'s payload. */
	async payload(n: number): Promise<Blob> {
		return (await client()).fetch(this.#session, n);
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
		let version: string | undefined;
		let failures = 0;
		while (!stop.signal.aborted) {
			const after = this.log.at(-1)?.n ?? 0;
			try {
				const log = await (await client()).log(
					this.#session,
					version === undefined ? { after } : { after, version },
					stop.signal,
				);
				failures = 0;
				version = log.version;
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

/** The person's own stream, received while the page is open, which shows
 * them awake: its unread items, by their session, and its positions, once
 * the first answer gave them. */
const stream = {
	unread: [] as { n: number; session: string }[],
	received: undefined as number | undefined,
	read: 0,
	/** The session open and visible, whose items are read. */
	shown: null as string | null,
	/** The receive waiting, which a change of `read` issues again. */
	request: null as AbortController | null,
};

/** The highest item with every one before it read: the unread ones of the
 * session shown go. */
function readNow(): number {
	const shown = document.visibilityState === "visible" ? stream.shown : null;
	stream.unread = stream.unread.filter((item) => item.session !== shown);
	return (stream.unread[0]?.n ?? (stream.received ?? 0) + 1) - 1;
}

/** Issues the receive again where the read position moved. */
function reread() {
	if (stream.received !== undefined && readNow() !== stream.read)
		stream.request?.abort();
}

async function receiving() {
	document.addEventListener("visibilitychange", reread);
	let failures = 0;
	for (;;) {
		const request = new AbortController();
		stream.request = request;
		// The first receive gets every unread item.
		if (stream.received !== undefined) stream.read = readNow();
		try {
			const answer = await (await client()).receive(
				stream.received === undefined
					? { received: 0, state: "awake" }
					: { received: stream.received, read: stream.read, state: "awake" },
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

/** Shows the session `id` in the page, or none: while the page is visible,
 * its items in the person's stream are read. The first call starts receiving
 * the stream. */
export function showSession(id: string | null) {
	if (stream.request === null) receiving();
	stream.shown = id;
	reread();
}
