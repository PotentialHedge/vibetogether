/**
 * Waiting for something an account sees to change, such as its overview.
 * Every write, any request but a GET, wakes every waiter, which checks whether what it waits on
 * differs now: no write has to say what it changed, and sessions are assumed small.
 */
import { createHash } from "node:crypto";
import { Refused } from "./transport.ts";

const waiters = new Set<{ user: string; wake: () => void }>();

/** At most this many waits of one account at once. */
const limit = 64;

/** Wakes every waiter, once the write is done. */
export function written(): void {
	setImmediate(() => {
		for (const w of [...waiters]) w.wake();
	});
}

/** A short version of `value`, which differs wherever it does. */
export function versionOf(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value))
		.digest("base64url")
		.slice(0, 16);
}

/**
 * The value of `current` once its version differs from `version`, or after `seconds` where given,
 * or at once where it already differs; `undefined` where the request was cut off.
 */
export function changed<T>(
	user: string,
	current: () => T,
	version: string,
	seconds: number | undefined,
	signal: AbortSignal,
): Promise<T | undefined> {
	const now = current();
	if (versionOf(now) !== version || seconds === 0) return Promise.resolve(now);
	if ([...waiters].filter((w) => w.user === user).length >= limit)
		return Promise.reject(
			new Refused(503, "This account has too many waits at once.", 10),
		);
	return new Promise((resolve) => {
		const end = (value: T | undefined) => {
			waiters.delete(waiter);
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			resolve(value);
		};
		const waiter = {
			user,
			wake: () => {
				const value = current();
				if (versionOf(value) !== version) end(value);
			},
		};
		const abort = () => end(undefined);
		const timer =
			seconds === undefined
				? undefined
				: setTimeout(() => end(current()), seconds * 1000);
		waiters.add(waiter);
		signal.addEventListener("abort", abort);
	});
}
