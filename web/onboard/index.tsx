/** The page a person meets first on any polylogue service: one prompt to give
 * their agent, which does everything else. Styled with Tailwind and shadcn's
 * theme variables, so it takes on each service's theme; the service adds this
 * directory to Tailwind's sources, as `@source "../node_modules/polylogue-web/onboard"`. */

import { type ReactNode, useState } from "react";

export type OnboardProps = {
	/** The service, as the person knows it, such as `voice.agentics.lwirth.com`. */
	name: string;
	/** What the person gets, in a few words. */
	title: string;
	/** One or two sentences on it. */
	description: string;
	/** The session's link, which names its relay. The page offers it on its
	 * own, and in the prompt that points the agent at the service's page for
	 * agents. */
	link: string;
	/** What the agent is to do once it has joined, such as `set up voice so we
	 * can talk`: without it, agents read the prompt as only joining. */
	goal?: string;
	/** Ways to set the service up that the person chooses between before the
	 * prompt, such as where voice runs. The chosen one's goal replaces `goal`,
	 * and no prompt shows until one is chosen. */
	choice?: Choice;
	/** The person's name, under which the prompt names their agent, as
	 * `<person>/<your name>`. */
	person?: string;
	/** What the person should know before, such as an account it needs. */
	note?: ReactNode;
};

export type Choice = {
	options: Option[];
	/** The option chosen, by its `id`, null for none yet. */
	chosen: string | null;
	choose(id: string): void;
};

export type Option = {
	id: string;
	/** Its name, in a word or two. */
	title: string;
	/** What it is, in one short sentence. */
	description: string;
	/** What it costs or needs, in a few words each, such as `Free`. */
	facts?: string[];
	/** What the agent is to do once it has joined, as `goal`. */
	goal: string;
};

const NAME = "polylogue-name";

/** Asks the person for the name they take part under, once per browser, and
 * renders the page under it, with `rename` to ask again, such as for a name
 * that is taken in the session. Every person in a session has a name of
 * their own, as every agent has. */
export function Named({
	service,
	children,
}: {
	/** The service, as the person knows it, such as `voice.agentics.lwirth.com`. */
	service: string;
	children: (name: string, rename: () => void) => ReactNode;
}) {
	const [name, setName] = useState(() => localStorage.getItem(NAME));
	const [draft, setDraft] = useState("");
	if (name)
		return children(name, () => {
			localStorage.removeItem(NAME);
			setDraft(name);
			setName(null);
		});
	const chosen = draft.trim();
	return (
		<Frame
			name={service}
			title="What's your name?"
			description="Everyone in the session, people and agents, sees you under it."
		>
			<form
				className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur sm:flex-row"
				onSubmit={(event) => {
					event.preventDefault();
					if (!chosen) return;
					localStorage.setItem(NAME, chosen);
					setName(chosen);
				}}
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: the one thing on the page
					autoFocus
					className="h-11 flex-1 rounded-xl bg-background/80 px-4 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
					placeholder="Your name"
					maxLength={64}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<button
					type="submit"
					disabled={!chosen}
					className="h-11 rounded-xl bg-primary px-6 font-medium text-primary-foreground transition-all outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:opacity-50"
				>
					Continue
				</button>
			</form>
		</Frame>
	);
}

/** The look every page of a person's onboarding shares, for a service's own
 * steps too. */
export function Frame({
	name,
	title,
	description,
	children,
}: {
	name: string;
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-6 py-16">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0"
				style={{
					background:
						"radial-gradient(60rem 30rem at 50% -10%, var(--onboard-glow, oklch(0.6 0.17 265 / 0.22)), transparent 70%)",
				}}
			/>
			<div className="relative flex w-full max-w-xl flex-col gap-10">
				<header className="flex flex-col gap-4">
					<span className="font-mono text-sm text-muted-foreground">
						{name}
					</span>
					<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
						{title}
					</h1>
					<p className="text-lg text-pretty text-muted-foreground">
						{description}
					</p>
				</header>
				{children}
				<footer className="text-xs text-muted-foreground">
					<a
						className="underline-offset-4 hover:text-foreground hover:underline"
						href="https://polylogue.agentics.lwirth.com"
					>
						polylogue
					</a>
					: bring your own agent
				</footer>
			</div>
		</div>
	);
}

export function Onboard({
	name,
	title,
	description,
	link,
	goal,
	choice,
	person,
	note,
}: OnboardProps) {
	const chosen = choice?.options.find((option) => option.id === choice.chosen);
	const as = person ? ` as ${person}/<your name>` : "";
	const aim = chosen ? chosen.goal : goal;
	const then = aim ? ` and ${aim}` : "";
	const prompt = `Read ${new URL("agents.md", document.baseURI)}, join the session ${link}${as}${then}.`;
	return (
		<Frame name={name} title={title} description={description}>
			{choice && <Options choice={choice} />}
			{(!choice || chosen) && (
				<section className="flex flex-col gap-3">
					<div className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur">
						<pre className="rounded-xl bg-background/80 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
							{prompt}
						</pre>
						<Copy
							text={prompt}
							label="Copy the prompt for your agent"
							primary
						/>
					</div>
					<p className="px-2 text-sm text-pretty text-muted-foreground">
						Paste it into your agent, such as Claude Code, and keep this page
						open: it goes on once your agent has joined.{" "}
						<CopyLink link={link} />
					</p>
				</section>
			)}
			{note && <p className="text-sm text-muted-foreground">{note}</p>}
		</Frame>
	);
}

/** The ways to set the service up, as large buttons side by side. */
function Options({ choice }: { choice: Choice }) {
	return (
		<fieldset className="grid gap-3 sm:grid-cols-2">
			{choice.options.map((option) => {
				const on = option.id === choice.chosen;
				return (
					<label
						key={option.id}
						className={`flex cursor-pointer flex-col gap-2 rounded-2xl border p-5 transition-all has-focus-visible:ring-3 has-focus-visible:ring-ring/50 active:translate-y-px ${on ? "border-primary/70 bg-card shadow-2xl shadow-black/30 ring-1 ring-primary/40" : "bg-card/40 hover:border-foreground/30 hover:bg-card/70"}`}
					>
						<input
							type="radio"
							name="onboard-choice"
							className="sr-only"
							checked={on}
							onChange={() => choice.choose(option.id)}
						/>
						<span className="flex items-center justify-between gap-3">
							<span className="text-xl font-semibold tracking-tight">
								{option.title}
							</span>
							<span
								aria-hidden
								className={`flex size-5 shrink-0 items-center justify-center rounded-full border transition ${on ? "border-primary bg-primary" : "border-muted-foreground/40"}`}
							>
								{on && (
									<span className="size-2 rounded-full bg-primary-foreground" />
								)}
							</span>
						</span>
						<span className="text-sm text-pretty text-muted-foreground">
							{option.description}
						</span>
						{option.facts && (
							<span className="mt-1 flex flex-wrap gap-1.5">
								{option.facts.map((fact) => (
									<span
										key={fact}
										className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
									>
										{fact}
									</span>
								))}
							</span>
						)}
					</label>
				);
			})}
		</fieldset>
	);
}

/** The session's link alone, for an agent that is given it some other way. */
function CopyLink({ link }: { link: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			title={link}
			className="text-foreground/80 underline underline-offset-4 hover:text-foreground"
			onClick={async () => {
				await navigator.clipboard.writeText(link);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			{copied ? "Link copied" : "Copy the session link alone"}
		</button>
	);
}

function Copy({
	text,
	label,
	primary = false,
}: {
	text: string;
	label: string;
	primary?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className={`flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-4 font-medium transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px ${primary ? "bg-primary text-primary-foreground hover:bg-primary/85" : "border bg-background/80 hover:bg-muted"}`}
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			<svg
				aria-hidden
				viewBox="0 0 24 24"
				className="size-4"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				{copied ? (
					<path d="M20 6 9 17l-5-5" />
				) : (
					<>
						<rect width="14" height="14" x="8" y="8" rx="2" />
						<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
					</>
				)}
			</svg>
			{copied ? "Copied" : label}
		</button>
	);
}
