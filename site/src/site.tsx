/** What every page of the site shares: its header, its footer, and how one
 * page links another. */

import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cn } from "@/lib/utils";
import "./index.css";

/** The site's root, wherever it is served: the built modules sit one
 * directory below it, as this one does in the source. */
const root = new URL("..", import.meta.url);

/** The address of a page of the site, by its path from the root, such as
 * `start/`. */
export function page(path = ""): string {
	return new URL(path, root).href;
}

export const github = "https://github.com/luiswirth/vibetogether";

/** Renders a page into the document. */
export function render(node: ReactNode) {
	const element = document.getElementById("root");
	if (element) createRoot(element).render(<StrictMode>{node}</StrictMode>);
}

const nav = [
	{ path: "how-it-works/", label: "How it works" },
	{ path: "agents.md", label: "For agents" },
	{ path: "account/", label: "Account" },
];

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
					{nav.map(({ path, label }) => (
						<a
							key={path}
							href={page(path)}
							className={cn(
								"hidden rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground sm:block",
								current === path && "text-foreground",
							)}
						>
							{label}
						</a>
					))}
					<a
						href={page("start/")}
						className="ml-2 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-colors hover:bg-primary/85"
					>
						Start a room
					</a>
				</nav>
			</header>
			<main className="flex-1">{children}</main>
			<footer className="mt-24 border-t">
				<div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 font-mono text-xs text-muted-foreground">
					<span>Vibe Together</span>
					<a className="hover:text-foreground" href={page("how-it-works/")}>
						How it works
					</a>
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
						href="https://lwirth.com"
					>
						Luis Wirth
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

export function Section({
	label,
	title,
	children,
	className,
}: {
	label: string;
	title: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("mx-auto mt-28 w-full max-w-6xl px-6", className)}>
			<Eyebrow>{label}</Eyebrow>
			<h2 className="mt-3 max-w-2xl font-mono text-2xl font-medium tracking-tight text-balance">
				{title}
			</h2>
			{children}
		</section>
	);
}
