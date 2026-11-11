/** The parts the pages of an account share: a person's face, and rows. */

import { type ReactNode, useEffect, useState } from "react";
import { api, Unauthorized } from "@/account/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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

/** One thing in a list: what it is, and on the right what can be done with
 * it, which goes below it where the two don't fit side by side. */
export function Row({
	children,
	actions,
	inset = false,
}: {
	children: ReactNode;
	actions?: ReactNode;
	/** Whether it belongs to the row above, such as an app's session. */
	inset?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4",
				inset && "py-3 pl-11",
			)}
		>
			<div className="flex min-w-0 flex-1 basis-40 items-center gap-3">
				{children}
			</div>
			{actions && (
				<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
					{actions}
				</div>
			)}
		</div>
	);
}

/** A row's title, with what it is about under it. */
export function Titled({
	title,
	detail,
}: {
	title: ReactNode;
	detail?: ReactNode;
}) {
	return (
		<span className="flex min-w-0 flex-col leading-tight">
			<span className="truncate font-mono">{title}</span>
			{detail && (
				<span className="mt-1 truncate text-sm text-muted-foreground">
					{detail}
				</span>
			)}
		</span>
	);
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
			className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
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
			<Input
				className="h-8 min-w-0 flex-1 font-mono sm:w-44 sm:flex-none"
				placeholder={placeholder}
				value={name}
				onChange={(event) => setName(event.target.value)}
			/>
			<Button type="submit" variant="outline" disabled={!name.trim()}>
				{label}
			</Button>
			{problem && (
				<span className="basis-full text-sm text-destructive">{problem}</span>
			)}
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
	return { problem, act, dismiss: () => setProblem(null) };
}

/** Reloads whenever anything the account sees changes, such as by an agent or
 * a friend, from `version`, the one the page's state was loaded at. */
export function useReloadOnChange(
	version: string | undefined,
	reload: () => Promise<void>,
) {
	useEffect(() => {
		if (version === undefined) return;
		const stop = new AbortController();
		(async () => {
			let seen = version;
			while (!stop.signal.aborted) {
				try {
					const next = await api.version(seen, stop.signal);
					if (next === seen) continue;
					seen = next;
					await reload();
				} catch (error) {
					if (stop.signal.aborted) return;
					if (error instanceof Unauthorized) return void (await reload());
					await new Promise((resolve) => setTimeout(resolve, 10_000));
				}
			}
		})();
		return () => stop.abort();
	}, [version, reload]);
}
