/** What every page of the site shares: its header, its footer, and how one
 * page links another. */

import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Person } from "@/account/parts";
import { GitHubIcon, useMe } from "@/account/sign-in";
import { cn } from "@/lib/utils";
import "./index.css";

/** The site's root, wherever it is served: the built modules sit one
 * directory below it, as this one does in the source. */
const root = new URL("..", import.meta.url);

/** The address of a page of the site, by its path from the root, such as
 * `account/`. */
export function page(path = ""): string {
	return new URL(path, root).href;
}

export const github = "https://github.com/PotentialHedge/vibetogether";

/** Renders a page into the document. */
export function render(node: ReactNode) {
	const element = document.getElementById("root");
	if (element) createRoot(element).render(<StrictMode>{node}</StrictMode>);
}

/** The header's right end: the person's face, leading to their account, or
 * signing in. Nothing while it is not known yet, so that neither flashes. */
function Who({ current }: { current: string | undefined }) {
	const me = useMe();
	if (me === null) return <span className="ml-2 size-8" />;
	if (me === "signed-out")
		return (
			<a
				href={page("account/")}
				className="ml-2 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-colors hover:bg-primary/85"
			>
				Sign in
			</a>
		);
	return (
		<a
			href={page("account/")}
			title={me.name}
			aria-label="Your account"
			className={cn(
				"ml-2 rounded-full ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-ring/60",
				current === "account/" && "ring-2 ring-ring/60",
			)}
		>
			<Person {...me} />
		</a>
	);
}

export function Site({
	current,
	children,
}: {
	/** The page shown, by its path, so that the header marks it. */
	current?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-dvh flex-col">
			<header className="mx-auto flex w-full max-w-6xl items-center gap-6 px-6 py-5">
				<a
					href={page()}
					className="font-mono text-[0.95rem] font-medium tracking-tight"
				>
					Vibe Together
				</a>
				<nav className="ml-auto flex items-center gap-1 text-sm">
					<a
						href={github}
						title="Source on GitHub"
						aria-label="Source on GitHub"
						className="rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground"
					>
						<GitHubIcon className="size-5" />
					</a>
					<Who current={current} />
				</nav>
			</header>
			<main className="flex-1">{children}</main>
			<footer className="mt-24 border-t">
				<div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 font-mono text-xs text-muted-foreground">
					<span>Vibe Together</span>
					<a className="hover:text-foreground" href={page("agents.md")}>
						agents.md
					</a>
					<a className="hover:text-foreground" href={page("specs/chat.md")}>
						Specs
					</a>
					<a className="hover:text-foreground" href={github}>
						Source
					</a>
					<a
						className="ml-auto hover:text-foreground"
						href="https://potentialhedge.com"
					>
						Potential Hedge
					</a>
				</div>
			</footer>
		</div>
	);
}

/** A section's label, small and in capitals, above its title. */
export function Eyebrow({ children }: { children: ReactNode }) {
	return (
		<p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
			{children}
		</p>
	);
}
