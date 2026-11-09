/** The parts the pages of an account share: a person's face, and panels of
 * rows. */

import { type ReactNode, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Person({
	name,
	displayName,
	image,
	size = "default",
}: {
	name: string;
	displayName?: string;
	image?: string;
	size?: "default" | "sm" | "lg";
}) {
	return (
		<Avatar size={size}>
			{image && <AvatarImage src={image} alt="" />}
			<AvatarFallback className="font-mono text-xs">
				{(displayName || name).slice(0, 1).toUpperCase()}
			</AvatarFallback>
		</Avatar>
	);
}

export function Panel({
	title,
	description,
	action,
	children,
}: {
	title: string;
	description: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="font-mono text-lg font-medium tracking-tight">
						{title}
					</h2>
					<p className="max-w-xl text-sm text-pretty text-muted-foreground">
						{description}
					</p>
				</div>
				{action}
			</div>
			<div className="divide-y overflow-hidden rounded-2xl border bg-card/50">
				{children}
			</div>
		</section>
	);
}

export function Row({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
			{children}
		</div>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return <p className="px-5 py-6 text-sm text-muted-foreground">{children}</p>;
}

/** A name to add, typed as a GitHub login, and the button that adds it. */
export function AddByName({
	placeholder,
	label,
	onAdd,
}: {
	placeholder: string;
	label: string;
	onAdd: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<form
			className="flex flex-wrap items-center gap-2"
			onSubmit={async (event) => {
				event.preventDefault();
				const chosen = name.trim().toLowerCase();
				if (!chosen) return;
				setProblem(null);
				try {
					await onAdd(chosen);
					setName("");
				} catch (error) {
					setProblem(error instanceof Error ? error.message : String(error));
				}
			}}
		>
			{problem && <span className="text-sm text-destructive">{problem}</span>}
			<Input
				className="h-8 w-44 font-mono"
				placeholder={placeholder}
				value={name}
				onChange={(event) => setName(event.target.value)}
			/>
			<Button type="submit" variant="outline" disabled={!name.trim()}>
				{label}
			</Button>
		</form>
	);
}

/** Runs an action, then reloads, and keeps what went wrong to show it. */
export function useActions(reload: () => Promise<void>) {
	const [problem, setProblem] = useState<string | null>(null);
	const act = (action: () => Promise<unknown>) => async () => {
		setProblem(null);
		try {
			await action();
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		}
		await reload();
	};
	return { problem, act };
}
