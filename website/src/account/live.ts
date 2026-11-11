/** A session as the page takes part in it: as the person, by the page's own
 * sign-in, through the same requests an agent makes with its token. */

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
	{ read: number; receiving: boolean; since?: string; status?: string }
>;

export const JOIN = "application/vnd.vibetogether.join";
export const LEAVE = "application/vnd.vibetogether.leave";
export const STATUS = "application/vnd.vibetogether.chat.status+json";

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
 * while the page receives. */
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

	async send(text: string, type: string): Promise<void> {
		await this.#call("/entries", {
			method: "POST",
			headers: { "Content-Type": type },
			body: text,
		});
	}

	fetch(n: number): Promise<Response> {
		return this.#call(`/entries/${n}`);
	}

	subscribe(subscriber: Subscriber): () => void {
		this.#subscribers.add(subscriber);
		return () => this.#subscribers.delete(subscriber);
	}

	#took(entries: Entry[], presence: Presence) {
		const last = this.log.at(-1)?.n ?? 0;
		const fresh = entries.filter((entry) => entry.n > last);
		if (fresh.length) {
			this.log = [...this.log, ...fresh];
			for (const s of this.#subscribers) s.entry();
		}
		this.presence = presence;
		for (const s of this.#subscribers) s.presence(presence);
	}

	/** Reads the log so far, then receives every change while the page is
	 * open, which shows the person as present. */
	async start(): Promise<void> {
		this.close();
		const stop = new AbortController();
		this.#stop = stop;
		try {
			for (;;) {
				const after = this.log.at(-1)?.n ?? 0;
				const answer = (await (
					await this.#call(`/log?after=${after}`, { signal: stop.signal })
				).json()) as { entries: Entry[]; presence: Presence };
				this.#took(answer.entries, answer.presence);
				if (!answer.entries.length) break;
			}
			let failures = 0;
			while (!stop.signal.aborted) {
				const after = this.log.at(-1)?.n ?? 0;
				try {
					const answer = (await (
						await this.#call(`/entries?wake=change&own=1&after=${after}`, {
							signal: stop.signal,
						})
					).json()) as { entries: Entry[]; presence: Presence };
					failures = 0;
					this.#took(answer.entries, answer.presence);
				} catch (error) {
					if (stop.signal.aborted) return;
					// A newer receive of the same sign-in, such as in another tab, or
					// a refusal: this one stops until the page is used again.
					if (error instanceof LiveError && error.status < 500) throw error;
					failures += 1;
					await new Promise((r) =>
						setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)),
					);
				}
			}
		} catch (error) {
			if (stop.signal.aborted) return;
			const why =
				error instanceof LiveError && error.status === 409
					? "This session is open in another tab."
					: String(error instanceof Error ? error.message : error);
			for (const s of this.#subscribers) s.end(why);
		}
	}

	close(): void {
		this.#stop?.abort();
		this.#stop = null;
	}
}
