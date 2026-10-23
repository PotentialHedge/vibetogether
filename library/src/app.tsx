import { Check, Copy, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Entry, TOPIC } from "./entries.ts";

const GUIDE = new URL("agents.md", document.baseURI).href;

/** The prompt that starts an agent on building something: one link, and what
 * the person wants, if they said. */
function prompt(what: string): string {
	const task = what.trim().replace(/\.$/, "");
	const start = `Read ${GUIDE} and build me something on byoa`;
	const publish = "and publish it to the library.";
	return task
		? `${start} that ${task}, ${publish}`
		: `${start}, ${publish} Ask me what it should do first.`;
}

type Listing =
	| { state: "loading" }
	| { state: "failed" }
	| { state: "loaded"; entries: Entry[] };

function useListing(): Listing {
	const [listing, setListing] = useState<Listing>({ state: "loading" });
	useEffect(() => {
		fetch("entries.json")
			.then((response) => {
				if (!response.ok) throw new Error(String(response.status));
				return response.json() as Promise<Entry[]>;
			})
			.then((entries) => setListing({ state: "loaded", entries }))
			.catch(() => setListing({ state: "failed" }));
	}, []);
	return listing;
}

function Build() {
	const [what, setWhat] = useState("");
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		await navigator.clipboard.writeText(prompt(what));
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};
	return (
		<section className="rounded-2xl border bg-card p-6 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.6)] sm:p-8">
			<h2 className="font-semibold text-xl tracking-tight">Build your own</h2>
			<p className="mt-2 max-w-[52ch] text-muted-foreground">
				Paste one prompt into Claude Code, or any agent with a shell. It reads
				how byoa works, builds what you asked for, and publishes it here.
			</p>
			<form
				className="mt-6 flex flex-col gap-3 sm:flex-row"
				onSubmit={(event) => {
					event.preventDefault();
					void copy();
				}}
			>
				<input
					value={what}
					onChange={(event) => setWhat(event.target.value)}
					placeholder="What should it do? (optional)"
					className="h-11 flex-1 rounded-xl border bg-background px-4 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
				/>
				<Button type="submit" size="lg" className="h-11 rounded-xl px-5">
					{copied ? <Check /> : <Copy />}
					{copied ? "Copied, paste it into your agent" : "Copy prompt"}
				</Button>
			</form>
			<code className="mt-4 block break-words rounded-lg bg-background p-3 font-mono text-muted-foreground text-xs">
				{prompt(what)}
			</code>
		</section>
	);
}

function Card({ entry }: { entry: Entry }) {
	const [owner, repository] = entry.name.split("/");
	return (
		<a
			href={entry.homepage ?? entry.url}
			className="group flex flex-col gap-2 rounded-2xl border bg-card p-5 transition-colors hover:border-ring/60"
		>
			<div className="flex items-center gap-2">
				<span className="font-semibold">{repository}</span>
				{entry.official && (
					<span className="rounded-full border border-brand/40 px-2 py-0.5 font-mono text-[0.6875rem] text-brand">
						official
					</span>
				)}
				<span className="ml-auto flex items-center gap-1 font-mono text-muted-foreground text-xs">
					<Star className="size-3.5" />
					{entry.stars}
				</span>
			</div>
			<span className="font-mono text-muted-foreground text-xs">{owner}</span>
			{entry.description && (
				<p className="text-muted-foreground text-sm">{entry.description}</p>
			)}
		</a>
	);
}

function Entries() {
	const listing = useListing();
	if (listing.state === "loading")
		return <p className="text-muted-foreground text-sm">Looking on GitHub…</p>;
	if (listing.state === "failed")
		return (
			<p className="text-muted-foreground text-sm">
				GitHub didn't answer. Find everything under the topic{" "}
				<a className="underline" href={`https://github.com/topics/${TOPIC}`}>
					{TOPIC}
				</a>{" "}
				instead.
			</p>
		);
	if (listing.entries.length === 0)
		return (
			<p className="text-muted-foreground text-sm">
				Nothing yet. Build the first one.
			</p>
		);
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{listing.entries.map((entry) => (
				<Card key={entry.name} entry={entry} />
			))}
		</div>
	);
}

export function App() {
	return (
		<main className="mx-auto max-w-5xl px-6">
			<nav className="flex items-center gap-6 py-6 text-muted-foreground text-sm">
				<a href="./" className="mr-auto font-mono text-foreground">
					byoa library
				</a>
				<a href="https://byoa.senses.sh" className="hover:text-foreground">
					byoa
				</a>
				<a href="agents.md" className="hover:text-foreground">
					Build guide
				</a>
			</nav>
			<header className="pt-16 pb-12">
				<h1 className="max-w-[18ch] text-balance font-semibold text-4xl tracking-tight sm:text-5xl">
					Everything built on byoa.
				</h1>
				<p className="mt-5 max-w-[52ch] text-lg text-muted-foreground">
					Clients, extensions and programs, made by people and their agents.
					Anything on GitHub with the topic{" "}
					<code className="font-mono text-foreground text-base">{TOPIC}</code>{" "}
					shows up here.
				</p>
			</header>
			<Build />
			<section className="py-16">
				<h2 className="mb-6 font-semibold text-xl tracking-tight">
					The library
				</h2>
				<Entries />
			</section>
			<footer className="flex gap-6 border-t py-10 text-muted-foreground text-sm">
				<span>byoa · bring your own agent</span>
				<a
					href="https://github.com/luiswirth/byoa-library"
					className="hover:text-foreground"
				>
					Source
				</a>
			</footer>
		</main>
	);
}
