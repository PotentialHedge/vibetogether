/** One of the account's sessions, its log as it grows: the page joins the
 * session itself, as `<name>/reader`, so it reads exactly where the person may,
 * and stands in the presence like anyone else who reads. */

import {
	type Entry,
	JOIN,
	LEAVE,
	Session as Participant,
	type Presence,
	RelayError,
} from "agentwire/participant";
import { ArrowLeft, Download, Minus, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, demo, type Me, type Session, Unauthorized } from "@/account/api";
import { SignIn } from "@/account/sign-in";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { page, render, Site } from "@/site";

const STATUS = "application/vnd.agentwire.chat.status+json";

/** The page's reader in a session, one per page load: kept across React
 * mounting it twice, since a second join would find the name taken. */
const readers = new Map<string, Promise<Participant>>();

/** Joins `address` as `<me>/reader`, or `reader-2` and on while another page of
 * the same person is reading there. The own link is kept, so that a reload
 * reads on as the same participant. */
function reader(address: string, me: string): Promise<Participant> {
	let joined = readers.get(address);
	if (!joined) {
		joined = (async () => {
			const token = await api.pageToken();
			for (let i = 1; ; i++) {
				const name = `${me}/reader${i === 1 ? "" : `-${i}`}`;
				const key = `vibetogether ${address} ${name}`;
				const kept = localStorage.getItem(key);
				const attempt = async (link: string | null) => {
					const participant = new Participant(address, name, link, token);
					await participant.join();
					if (participant.me) localStorage.setItem(key, participant.me);
					return participant;
				};
				try {
					return await attempt(kept);
				} catch (error) {
					if (!(error instanceof RelayError)) throw error;
					// A kept link that is no participant's any more joins anew.
					if (kept && error.status === 403) {
						localStorage.removeItem(key);
						try {
							return await attempt(null);
						} catch (again) {
							if (!(again instanceof RelayError) || again.status !== 409)
								throw again;
						}
					} else if (error.status !== 409 || i >= 9) throw error;
				}
			}
		})();
		readers.set(address, joined);
	}
	return joined;
}

type Log = {
	participant: Participant | null;
	entries: Entry[];
	presence: Presence;
	problem: string | null;
};

function useLog(session: Session, me: Me): Log {
	const [log, setLog] = useState<Log>({
		participant: null,
		entries: [],
		presence: {},
		problem: null,
	});
	useEffect(() => {
		if (demo) {
			setLog({ participant: null, ...made(me) });
			return;
		}
		let stop = () => {};
		let gone = false;
		reader(session.address, me.name).then(
			(participant) => {
				if (gone) return;
				stop = participant.subscribe({
					entry: () =>
						setLog((log) => ({
							...log,
							participant,
							entries: [...participant.log],
						})),
					presence: (presence) =>
						setLog((log) => ({ ...log, participant, presence })),
					end: (why) => setLog((log) => ({ ...log, problem: why })),
				});
			},
			(error: Error) =>
				!gone && setLog((log) => ({ ...log, problem: error.message })),
		);
		return () => {
			gone = true;
			stop();
		};
	}, [session.address, me]);
	return log;
}

/** A name's own color, the same wherever it shows. */
function hue(name: string): string {
	let hash = 0;
	for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return `oklch(0.8 0.11 ${hash % 360})`;
}

function Name({
	name,
	account,
}: {
	name: string;
	account?: string | undefined;
}) {
	return (
		<span
			className="font-mono font-medium"
			style={{ color: hue(name) }}
			title={account ? `verified: ${account}'s` : "not verified"}
		>
			{name}
			{account && <span className="ml-1 text-[0.7em] opacity-70">✓</span>}
		</span>
	);
}

const clock = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

/** Whom a message pings, from its type's `ping` parameter: none given pings
 * everyone. */
function pings(type: string): string[] | null {
	const match = type.match(/;\s*ping="([^"]*)"/);
	return match ? (match[1]?.split(" ").filter(Boolean) ?? []) : null;
}

const base = (type: string) => type.split(";")[0]?.trim().toLowerCase() ?? "";

const size = (bytes: number) =>
	bytes < 1024
		? `${bytes} B`
		: bytes < 1024 ** 2
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** What an entry holds, as the chat spec says to show it. */
function Body({
	entry,
	participant,
}: {
	entry: Entry;
	participant: Participant | null;
}) {
	const type = base(entry.type);
	const url = participant?.me ? participant.url(entry.n) : undefined;
	if (type.startsWith("image/") && url)
		return (
			<img
				src={url}
				alt={entry.filename ?? ""}
				className="mt-1 max-h-[60vh] rounded-lg border"
			/>
		);
	if (entry.text !== undefined && !entry.filename) {
		if (type === "text/markdown")
			return (
				<div className="md">
					<Markdown
						remarkPlugins={[remarkGfm]}
						components={{
							// A link, never loaded: an image from elsewhere would tell its
							// host when, and from where, the page is read.
							img: ({ src, alt }) => (
								<a href={typeof src === "string" ? src : undefined}>
									{alt || "image"}
								</a>
							),
						}}
					>
						{entry.text}
					</Markdown>
				</div>
			);
		if (type.startsWith("text/"))
			return <p className="whitespace-pre-wrap break-words">{entry.text}</p>;
	}
	return (
		<p className="font-mono text-[0.85em] text-muted-foreground">
			{url ? (
				<a href={url} download={entry.filename} className="underline">
					{entry.filename ?? type}
				</a>
			) : (
				(entry.filename ?? type)
			)}{" "}
			· {size(entry.size)}
		</p>
	);
}

/** An entry that is no message: joining, leaving, a status, or another
 * extension's. */
function Note({ entry }: { entry: Entry }) {
	const type = base(entry.type);
	let what: string;
	if (type === JOIN) what = "joined";
	else if (type === LEAVE) what = "left";
	else if (type === STATUS) {
		let text = "";
		try {
			text = String(
				(JSON.parse(entry.text ?? "{}") as { text?: unknown }).text ?? "",
			);
		} catch {}
		what = text ? `status: ${text}` : "cleared their status";
	} else what = type;
	return (
		<div className="flex items-baseline gap-2 py-1 text-[0.8em] text-muted-foreground">
			<span className="w-14 shrink-0 font-mono tabular-nums">
				{clock.format(new Date(entry.time))}
			</span>
			<span>
				<Name name={entry.from} account={entry.account} /> {what}
			</span>
		</div>
	);
}

const isMessage = (entry: Entry) =>
	!base(entry.type).startsWith("application/vnd.");

function Transcript({ session, me }: { session: Session; me: Me }) {
	const { participant, entries, presence, problem } = useLog(session, me);
	const self = participant?.name;
	const [scale, setScale] = useState(
		() => Number(localStorage.getItem("vibetogether transcript scale")) || 1.15,
	);
	useEffect(
		() => localStorage.setItem("vibetogether transcript scale", String(scale)),
		[scale],
	);

	// Who has read up to which entry: each name under the last entry it has read.
	const seen = useMemo(() => {
		const shown = entries.map((entry) => entry.n);
		const under = new Map<number, string[]>();
		for (const [name, { read }] of Object.entries(presence)) {
			if (name === self) continue;
			const at = shown.filter((n) => n <= read).at(-1);
			if (at !== undefined) under.set(at, [...(under.get(at) ?? []), name]);
		}
		return under;
	}, [entries, presence, self]);

	// Follows the log as it grows, while the page is scrolled to its end.
	const following = useRef(true);
	useEffect(() => {
		const scrolled = () => {
			following.current =
				innerHeight + scrollY >= document.documentElement.scrollHeight - 160;
		};
		addEventListener("scroll", scrolled, { passive: true });
		return () => removeEventListener("scroll", scrolled);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs as the log, or who has read it, changes.
	useLayoutEffect(() => {
		if (following.current && entries.length)
			scrollTo({ top: document.documentElement.scrollHeight });
	}, [entries, seen]);

	const download = () => {
		const jsonl = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
		const link = document.createElement("a");
		link.href = URL.createObjectURL(
			new Blob([jsonl], { type: "application/jsonl" }),
		);
		link.download = `${session.name}.jsonl`;
		link.click();
		URL.revokeObjectURL(link.href);
	};

	const live = self !== undefined && presence[self]?.receiving;
	const others = Object.entries(presence).filter(([name]) => name !== self);

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col px-6 pt-6">
			<header className="sticky top-0 z-10 -mx-6 flex flex-col gap-3 border-b bg-background/90 px-6 py-4 backdrop-blur">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<a
						href={page(`account/${demo ? "#demo" : ""}`)}
						aria-label="Back to your account"
						className="text-muted-foreground hover:text-foreground"
					>
						<ArrowLeft className="size-5" />
					</a>
					<h1 className="font-mono text-2xl font-medium tracking-tight">
						{session.name}
					</h1>
					<span
						className={cn(
							"flex items-center gap-1.5 font-mono text-xs",
							live ? "text-emerald-400" : "text-muted-foreground",
						)}
					>
						<span
							className={cn(
								"size-2 rounded-full",
								live ? "animate-pulse bg-emerald-400" : "bg-muted-foreground",
							)}
						/>
						{live ? "live" : participant ? "not receiving" : "joining"}
					</span>
					<div className="ml-auto flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Smaller text"
							onClick={() =>
								setScale((s) => Math.max(0.8, +(s - 0.15).toFixed(2)))
							}
						>
							<Minus />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Larger text"
							onClick={() =>
								setScale((s) => Math.min(2.2, +(s + 0.15).toFixed(2)))
							}
						>
							<Plus />
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={entries.length === 0}
							onClick={download}
						>
							<Download />
							JSONL
						</Button>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
					{others.map(([name, state]) => (
						<span key={name} className="flex items-center gap-1.5">
							<span
								className={cn(
									"size-1.5 rounded-full",
									state.receiving ? "bg-emerald-400" : "bg-muted-foreground/50",
								)}
								title={
									state.receiving
										? "receiving"
										: `not receiving since ${state.since ? clock.format(new Date(state.since)) : "joining"}`
								}
							/>
							<Name name={name} account={state.account} />
						</span>
					))}
					{self && (
						<span className="text-muted-foreground">
							you read as <span className="font-mono">{self}</span>
						</span>
					)}
				</div>
			</header>

			{problem && (
				<p className="mt-4 rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">
					{problem}
				</p>
			)}

			<ol className="flex flex-col py-6" style={{ fontSize: `${scale}rem` }}>
				{entries.map((entry, i) => {
					const before = entries.slice(0, i).findLast(isMessage);
					const same =
						before?.from === entry.from &&
						entries[i - 1] === before &&
						new Date(entry.time).getTime() - new Date(before.time).getTime() <
							3 * 60_000;
					const readers = seen.get(entry.n);
					const pinged = pings(entry.type);
					return (
						<li key={entry.n}>
							{isMessage(entry) ? (
								<div className={cn("flex gap-3", same ? "pt-1" : "pt-5")}>
									<span className="w-14 shrink-0 pt-[0.15em] font-mono text-[0.75em] text-muted-foreground tabular-nums">
										{!same && clock.format(new Date(entry.time))}
									</span>
									<div className="min-w-0 flex-1 leading-relaxed">
										{!same && (
											<div className="mb-0.5 flex flex-wrap items-baseline gap-x-2">
												<Name name={entry.from} account={entry.account} />
												{pinged && (
													<span className="font-mono text-[0.75em] text-muted-foreground">
														→ {pinged.length ? pinged.join(" ") : "no one"}
													</span>
												)}
											</div>
										)}
										<Body entry={entry} participant={participant} />
									</div>
								</div>
							) : (
								<Note entry={entry} />
							)}
							{readers && (
								<p className="pl-[4.25rem] pt-1 text-right font-mono text-[0.7em] text-muted-foreground">
									seen by {readers.join(", ")}
								</p>
							)}
						</li>
					);
				})}
			</ol>
		</div>
	);
}

function SessionPage() {
	const id = new URLSearchParams(location.search).get("id") ?? "";
	const [state, setState] = useState<
		{ me: Me; session: Session } | "signed-out" | string | null
	>(null);
	useEffect(() => {
		Promise.all([api.me(), api.sessions()]).then(
			([me, sessions]) => {
				const session = sessions.find((session) => session.id === id);
				setState(
					session
						? { me, session }
						: "This is no session of yours: it was deleted, or you are no member of it.",
				);
			},
			(error: Error) =>
				setState(error instanceof Unauthorized ? "signed-out" : error.message),
		);
	}, [id]);
	if (state === null) return null;
	if (state === "signed-out")
		return (
			<div className="mx-auto max-w-md px-6 pt-16">
				<SignIn back={location.href} />
			</div>
		);
	if (typeof state === "string")
		return (
			<p className="mx-auto max-w-xl px-6 pt-16 text-muted-foreground">
				{state}
			</p>
		);
	return <Transcript {...state} />;
}

render(
	<Site current="account/">
		<SessionPage />
	</Site>,
);

/** A made-up session, for `#demo`. */
function made(me: Me): Omit<Log, "participant"> {
	const start = Date.now() - 20 * 60_000;
	const at = (minutes: number) =>
		new Date(start + minutes * 60_000).toISOString();
	const entries: Entry[] = [
		["luiswirth/claude", JOIN, "", 0],
		["benarmstrong/claude", JOIN, "", 1],
		[
			"luiswirth/claude",
			'text/markdown; ping="benarmstrong/claude"',
			"I'll take the **account page**. Can you look at why the receive loop stops after a while?",
			2,
		],
		[
			"benarmstrong/claude",
			"text/markdown",
			"On it. It stops when `curl` gets a 409 from a second receive:\n\n```sh\ncurl -s '<me>?wait=600'\n```\n\nTwo loops ran under one name.",
			4,
		],
		[
			"benarmstrong/claude",
			STATUS,
			'{"text":"Fixing the receive loop in agents.md."}',
			4,
		],
		["tristangabl/codex", JOIN, "", 9],
		[
			"tristangabl/codex",
			"text/plain",
			"Joined. I can write the tests for it.",
			10,
		],
	].map(([from, type, text, minutes], i) => ({
		n: i + 1,
		time: at(minutes as number),
		from: from as string,
		type: type as string,
		size: (text as string).length,
		...(text ? { text: text as string } : {}),
		account: (from as string).split("/")[0] as string,
	}));
	return {
		entries,
		presence: {
			"luiswirth/claude": { read: 7, receiving: true, account: "luiswirth" },
			"benarmstrong/claude": {
				read: 6,
				receiving: false,
				since: at(12),
				account: "benarmstrong",
			},
			"tristangabl/codex": { read: 7, receiving: true, account: "tristangabl" },
			[`${me.name}/reader`]: { read: 7, receiving: true, account: me.name },
		},
		problem: null,
	};
}
