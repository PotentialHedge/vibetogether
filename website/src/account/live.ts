/** A session as the page takes part in it, and the person's own stream: as
 * the person, by the page's own sign-in, through the same requests an agent
 * makes with its token. */

import { page } from "@/site";

export type Entry = {
	n: number;
	time: string;
	from: string;
	type: string;
	size: number;
	filename?: string;
	text?: string;
};

export type Presence = Record<
	string,
	{
		id: string;
		/** The last entry that reached its side. */
		received: number;
		/** The last entry that reached its context, or that the person saw. */
		read: number;
		/** Awake or asleep while its receive waits, or ended moments ago. */
		presence: "awake" | "asleep" | "offline";
		since?: string;
		status?: string;
	}
>;

export const JOIN = "application/vnd.vibetogether.join";
export const LEAVE = "application/vnd.vibetogether.leave";

export class LiveError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function checked(response: Response): Promise<Response> {
	if (!response.ok)
		throw new LiveError(
			response.status,
			(await response.text()) || response.statusText,
		);
	return response;
}

export type Subscriber = {
	entry: () => void;
	presence: (presence: Presence) => void;
	/** The page stopped receiving, with why. */
	end: (why: string) => void;
};

/** The person in a session: its log so far, and who is in it, kept current
 * while the page observes it. */
export class Seat {
	log: Entry[] = [];
	presence: Presence = {};
	#base: string;
	#subscribers = new Set<Subscriber>();
	#stop: AbortController | null = null;

	constructor(session: string) {
		this.#base = page(`api/sessions/${encodeURIComponent(session)}`);
	}

	async #call(path: string, init: RequestInit = {}): Promise<Response> {
		return checked(
			await fetch(`${this.#base}${path}`, {
				credentials: "same-origin",
				...init,
			}),
		);
	}

	/** Joins, or does nothing where the person is in already. */
	async join(): Promise<void> {
		await this.#call("/participants", { method: "POST" });
	}

	/** Sends, and returns the names its `ping` or `fyi` lists that don't see
	 * the session, so are reached by nothing. */
	async send(text: string, type: string): Promise<string[]> {
		const answer = (await (
			await this.#call("/entries", {
				method: "POST",
				headers: { "Content-Type": type },
				body: text,
			})
		).json()) as { n: number; unreached?: string[] };
		return answer.unreached ?? [];
	}

	fetch(n: number): Promise<Response> {
		return this.#call(`/entries/${n}`);
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
		let version = "";
		let failures = 0;
		while (!stop.signal.aborted) {
			const after = this.log.at(-1)?.n ?? 0;
			try {
				const log = (await (
					await this.#call(
						`/log?after=${after}${version && `&version=${version}`}`,
						{ signal: stop.signal },
					)
				).json()) as { entries: Entry[]; presence: Presence; version: string };
				failures = 0;
				version = log.version;
				if (log.entries.length) {
					this.log = [...this.log, ...log.entries];
					for (const s of this.#subscribers) s.entry();
				}
				this.presence = log.presence;
				for (const s of this.#subscribers) s.presence(log.presence);
			} catch (error) {
				if (stop.signal.aborted) return;
				// A refusal: this one stops until the page is used again.
				if (error instanceof LiveError && error.status < 500) {
					for (const s of this.#subscribers) s.end(error.message);
					return;
				}
				failures += 1;
				await new Promise((r) =>
					setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)),
				);
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
		const positions =
			stream.received === undefined
				? "received=0"
				: `received=${stream.received}&read=${stream.read}`;
		try {
			const answer = (await (
				await checked(
					await fetch(page(`api/receive?${positions}&state=awake`), {
						credentials: "same-origin",
						signal: request.signal,
					}),
				)
			).json()) as {
				items: { n: number; session: { id: string } }[];
				received: number;
			};
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
			if (error instanceof LiveError && error.status < 500) return;
			failures += 1;
			await new Promise((r) =>
				setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)),
			);
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
