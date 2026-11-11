/** One of the account's sessions, its log as it grows: the app reads it
 * without joining, with the token of its own sign-in, so it reads exactly
 * where the person may, and stands in no presence. */

import {
	type Entry,
	JOIN,
	LEAVE,
	type Presence,
	Reader,
} from "agentwire/participant";
import {
	ArrowLeftRight,
	Download,
	Ellipsis,
	Minus,
	Plus,
	Users,
} from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, demo, type Session } from "@/account/api";
import { MoreInfo } from "@/components/more-info";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const STATUS = "application/vnd.agentwire.chat.status+json";

/** The app's reader of a session, one per address: kept across React mounting
 * it twice, and across opening the session again. */
const readers = new Map<string, Promise<Reader>>();

function reader(address: string): Promise<Reader> {
	let made = readers.get(address);
	if (!made) {
		made = api.pageToken().then((token) => new Reader(address, token));
		readers.set(address, made);
	}
	return made;
}

type Log = {
	reading: boolean;
	/** What fetches the payloads, once it is made: none in the demo. */
	reader: Reader | null;
	entries: Entry[];
	presence: Presence;
	problem: string | null;
};

function useLog(session: Pick<Session, "address">): Log {
	const [log, setLog] = useState<Log>({
		reading: false,
		reader: null,
		entries: [],
		presence: {},
		problem: null,
	});
	useEffect(() => {
		if (demo) {
			setLog({ reading: true, reader: null, ...made() });
			return;
		}
		let stop = () => {};
		let gone = false;
		reader(session.address).then(
			(reader) => {
				if (gone) return;
				setLog((log) => ({ ...log, reader }));
				stop = reader.subscribe({
					entry: () =>
						setLog((log) => ({
							...log,
							reading: true,
							entries: [...reader.log],
						})),
					presence: (presence) =>
						setLog((log) => ({ ...log, reading: true, presence })),
					end: (why) =>
						setLog((log) => ({ ...log, reading: false, problem: why })),
				});
			},
			(error: Error) =>
				!gone && setLog((log) => ({ ...log, problem: error.message })),
		);
		return () => {
			gone = true;
			stop();
		};
	}, [session.address]);
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
function Body({ entry, reader }: { entry: Entry; reader: Reader | null }) {
	const type = base(entry.type);
	if (RASTER.has(type) && reader)
		return <Picture entry={entry} reader={reader} />;
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
			{reader ? (
				<button
					type="button"
					className="underline underline-offset-4 hover:text-foreground"
					onClick={async () => {
						// Opaque bytes: nothing done with the URL renders the
						// sender's HTML or SVG on the site's own origin.
						const blob = new Blob(
							[await (await reader.fetch(entry.n)).blob()],
							{ type: "application/octet-stream" },
						);
						const link = document.createElement("a");
						link.href = URL.createObjectURL(blob);
						link.download = entry.filename ?? `${entry.n}`;
						link.click();
						URL.revokeObjectURL(link.href);
					}}
				>
					{entry.filename ?? type}
				</button>
			) : (
				(entry.filename ?? type)
			)}{" "}
			· {size(entry.size)}
		</p>
	);
}

/** The images shown in place: raster only, since a blob URL is the site's own
 * origin, where an SVG opened on its own would run as a page. */
const RASTER = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
]);

/** A raster image sent into the session, fetched with the reader's token,
 * since the log's payloads need it, and typed as its entry says. */
function Picture({ entry, reader }: { entry: Entry; reader: Reader }) {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		let made: string | null = null;
		let gone = false;
		reader.fetch(entry.n).then(
			async (response) => {
				const blob = new Blob([await response.blob()], {
					type: base(entry.type),
				});
				if (gone) return;
				made = URL.createObjectURL(blob);
				setUrl(made);
			},
			() => {},
		);
		return () => {
			gone = true;
			if (made) URL.revokeObjectURL(made);
		};
	}, [entry.n, entry.type, reader]);
	if (!url)
		return (
			<p className="font-mono text-[0.85em] text-muted-foreground">
				{entry.filename ?? "image"} · {size(entry.size)}
			</p>
		);
	return (
		<img
			src={url}
			alt={entry.filename ?? ""}
			className="mt-1 max-h-[60vh] rounded-lg border"
		/>
	);
}

/** A status's text, empty where it was cleared. */
function statusOf(entry: Entry): string {
	try {
		return String(
			(JSON.parse(entry.text ?? "{}") as { text?: unknown }).text ?? "",
		);
	} catch {
		return "";
	}
}

/** The status each participant set last, by name, leaving out the cleared. */
function statuses(entries: Entry[]): Map<string, string> {
	const latest = new Map<string, string>();
	for (const entry of entries)
		if (base(entry.type) === STATUS) {
			const text = statusOf(entry);
			if (text) latest.set(entry.from, text);
			else latest.delete(entry.from);
		}
	return latest;
}

/** An entry that is no message: joining, leaving, a status, or another
 * extension's. */
function Note({ entry }: { entry: Entry }) {
	const type = base(entry.type);
	let what: string;
	if (type === JOIN) what = "joined";
	else if (type === LEAVE) what = "left";
	else if (type === STATUS) {
		const text = statusOf(entry);
		what = text ? `status: ${text}` : "cleared their status";
	} else what = type;
	// The same columns as a message's, so names and times line up.
	return (
		<div className="flex items-baseline gap-3 py-1 text-muted-foreground">
			<span className="w-12 shrink-0 font-mono text-[0.75em] tabular-nums">
				{clock.format(new Date(entry.time))}
			</span>
			<span className="min-w-0 text-[0.8em]">
				<Name name={entry.from} account={entry.account} /> {what}
			</span>
		</div>
	);
}

const isMessage = (entry: Entry) =>
	!base(entry.type).startsWith("application/vnd.");

/** Who is in the session, each with whether it receives and its status. */
function People({
	presence,
	status,
}: {
	presence: Presence;
	status: Map<string, string>;
}) {
	const others = Object.entries(presence);
	return (
		<div className="flex flex-col gap-3">
			<h2 className="flex h-5 items-center font-mono text-xs tracking-wide text-muted-foreground uppercase">
				Here · {others.length}
				<MoreInfo label="About who is here">
					A green dot is receiving now, a gray one has joined but is not
					receiving, since the time beside it. A ✓ means the name is verified as
					that account's. Under each name is the status it set last.
				</MoreInfo>
			</h2>
			<ul className="flex flex-col gap-3 text-sm">
				{others.map(([name, state]) => (
					<li key={name} className="flex min-w-0 gap-2">
						<span
							className={cn(
								"mt-[0.45rem] size-1.5 shrink-0 rounded-full",
								state.receiving ? "bg-emerald-400" : "bg-muted-foreground/50",
							)}
							title={
								state.receiving
									? "receiving"
									: `not receiving since ${state.since ? clock.format(new Date(state.since)) : "joining"}`
							}
						/>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="flex min-w-0 items-baseline gap-2">
								<span className="truncate">
									<Name name={name} account={state.account} />
								</span>
								{!state.receiving && state.since && (
									<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
										{clock.format(new Date(state.since))}
									</span>
								)}
							</span>
							{status.get(name) && (
								<span className="text-pretty text-muted-foreground">
									{status.get(name)}
								</span>
							)}
						</span>
					</li>
				))}
				{others.length === 0 && (
					<li className="text-muted-foreground">No one is here.</li>
				)}
			</ul>
		</div>
	);
}

/** A session, live: its log as it grows, who is there and their status. */
export function Transcript({
	session,
	actions,
	menu,
	back,
}: {
	/** A session or a DM, as far as the transcript shows it. */
	session: Pick<Session, "name" | "address" | "bridges">;
	/** What can be done with the session, at the header's end. */
	actions?: ReactNode;
	/** What else can be done with it, as items of its menu. */
	menu?: ReactNode;
	/** Leads back to the sessions, where they are not beside it. */
	back?: ReactNode;
}) {
	const { reading, reader, entries, presence, problem } = useLog(session);
	const status = useMemo(() => statuses(entries), [entries]);
	const [people, setPeople] = useState(false);
	const [scale, setScale] = useState(
		() => Number(localStorage.getItem("vibetogether transcript scale")) || 1,
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
			const at = shown.filter((n) => n <= read).at(-1);
			if (at !== undefined) under.set(at, [...(under.get(at) ?? []), name]);
		}
		return under;
	}, [entries, presence]);

	// Follows the log as it grows, while it is scrolled to its end.
	const scroller = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs as the log, or who has read it, changes.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && following.current && entries.length)
			element.scrollTop = element.scrollHeight;
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

	const count = Object.keys(presence).length;

	return (
		<div className="flex h-full min-h-0">
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex flex-col gap-3 border-b px-4 py-3 md:px-6">
					<div className="flex items-center gap-x-3 gap-y-2">
						{back}
						<h1 className="min-w-0 truncate font-mono text-lg font-medium tracking-tight">
							{session.name}
						</h1>
						<span
							title={reading ? "live" : "not reading"}
							className={cn(
								"size-2 shrink-0 rounded-full",
								reading
									? "animate-pulse bg-emerald-400"
									: "bg-muted-foreground",
							)}
						/>
						<div className="ml-auto flex shrink-0 items-center gap-1">
							{actions}
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button variant="ghost" size="icon-sm" aria-label="More" />
									}
								>
									<Ellipsis />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-48">
									{menu}
									{menu && <DropdownMenuSeparator />}
									<DropdownMenuItem
										closeOnClick={false}
										onClick={() =>
											setScale((s) => Math.min(2.2, +(s + 0.15).toFixed(2)))
										}
									>
										<Plus />
										Larger text
									</DropdownMenuItem>
									<DropdownMenuItem
										closeOnClick={false}
										onClick={() =>
											setScale((s) => Math.max(0.8, +(s - 0.15).toFixed(2)))
										}
									>
										<Minus />
										Smaller text
									</DropdownMenuItem>
									<DropdownMenuItem
										disabled={entries.length === 0}
										onClick={download}
									>
										<Download />
										Download JSONL
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
							<Button
								variant={people ? "secondary" : "ghost"}
								size="sm"
								className="xl:hidden"
								aria-label="Who is here"
								aria-pressed={people}
								onClick={() => setPeople((open) => !open)}
							>
								<Users />
								{count}
							</Button>
						</div>
					</div>
					{session.bridges?.map((bridge) => (
						<p
							key={`${bridge.bridge} ${bridge.by} ${bridge.about}`}
							className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
						>
							<ArrowLeftRight className="size-3.5 shrink-0" />
							<span className="min-w-0 truncate">
								Everyone in {bridge.about ?? `a ${bridge.bridge} room`} sees
								this
							</span>
							<MoreInfo label="About this bridge">
								Added by {bridge.by}, through {bridge.bridge}. What is said
								there shows here too.
							</MoreInfo>
						</p>
					))}
					{people && (
						<div className="pb-1 xl:hidden">
							<People presence={presence} status={status} />
						</div>
					)}
				</header>

				{problem && (
					<p className="mx-4 mt-4 rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive md:mx-6">
						{problem}
					</p>
				)}

				<div
					ref={scroller}
					className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6"
					onScroll={(event) => {
						const element = event.currentTarget;
						following.current =
							element.scrollTop + element.clientHeight >=
							element.scrollHeight - 160;
					}}
				>
					<ol
						className="mx-auto flex max-w-4xl flex-col py-4"
						style={{ fontSize: `${scale}rem` }}
					>
						{entries.length === 0 && !problem && (
							<li className="py-8 text-center text-sm text-muted-foreground">
								{reading ? "Nothing said yet." : "Reading…"}
							</li>
						)}
						{entries.map((entry, i) => {
							const before = entries.slice(0, i).findLast(isMessage);
							const same =
								before?.from === entry.from &&
								entries[i - 1] === before &&
								new Date(entry.time).getTime() -
									new Date(before.time).getTime() <
									3 * 60_000;
							const readers = seen.get(entry.n);
							const pinged = pings(entry.type);
							return (
								<li key={entry.n}>
									{isMessage(entry) ? (
										<div className={cn("flex gap-3", same ? "pt-1" : "pt-5")}>
											<span className="w-12 shrink-0 pt-[0.15em] font-mono text-[0.75em] text-muted-foreground tabular-nums">
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
												<Body entry={entry} reader={reader} />
											</div>
										</div>
									) : (
										<Note entry={entry} />
									)}
									{readers && (
										<p className="pt-1 pl-15 text-right font-mono text-[0.7em] text-muted-foreground">
											seen by {readers.join(", ")}
										</p>
									)}
								</li>
							);
						})}
					</ol>
				</div>
			</div>
			<aside className="hidden w-72 shrink-0 overflow-y-auto border-l px-5 py-4 xl:block">
				<People presence={presence} status={status} />
			</aside>
		</div>
	);
}

/** A made-up session, for `#demo`. */
function made(): Omit<Log, "reading" | "reader"> {
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
		},
		problem: null,
	};
}
