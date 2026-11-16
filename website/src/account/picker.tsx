/** A picker: a button that opens a searchable, scrolling list of choices,
 * each ticked or not, so that it scales to many. Clicking a choice acts at
 * once, and the list stays open for the next. */

import { Check, Search } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type Choice = {
	id: string;
	/** What it is called, which the search matches. */
	name: string;
	/** What stands before the name, such as a face or a presence. */
	face?: ReactNode;
	/** A short line after the name, such as whose agent it is. */
	detail?: string;
	ticked: boolean;
};

export function Picker({
	trigger,
	title,
	choices,
	onPick,
	empty,
	side = "bottom",
	align = "start",
}: {
	/** The button that opens it. */
	trigger: ReactElement;
	/** One line on what ticking does. */
	title: string;
	choices: Choice[];
	onPick: (choice: Choice) => Promise<unknown>;
	/** What it says where there is nothing to choose. */
	empty: ReactNode;
	side?: "top" | "bottom" | "left" | "right";
	align?: "start" | "center" | "end";
}) {
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const shown = choices.filter((choice) =>
		choice.name.toLowerCase().includes(query.trim().toLowerCase()),
	);
	return (
		<Popover
			onOpenChange={(open) => {
				if (!open) {
					setQuery("");
					setProblem(null);
				}
			}}
		>
			<PopoverTrigger render={trigger} />
			<PopoverContent
				side={side}
				align={align}
				className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 p-2"
			>
				<p className="px-1 pt-1 text-xs text-muted-foreground">{title}</p>
				{choices.length > 6 && (
					<div className="relative">
						<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							autoFocus
							className="h-8 pl-8"
							placeholder="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
				)}
				<ul className="flex max-h-64 flex-col overflow-y-auto">
					{choices.length === 0 ? (
						<li className="px-2 py-1.5 text-sm text-muted-foreground">
							{empty}
						</li>
					) : shown.length === 0 ? (
						<li className="px-2 py-1.5 text-sm text-muted-foreground">
							Nothing matches.
						</li>
					) : (
						shown.map((choice) => (
							<li key={choice.id}>
								<button
									type="button"
									role="menuitemcheckbox"
									aria-checked={choice.ticked}
									disabled={busy !== null}
									onClick={async () => {
										setBusy(choice.id);
										setProblem(null);
										try {
											await onPick(choice);
										} catch (error) {
											setProblem(
												error instanceof Error ? error.message : String(error),
											);
										}
										setBusy(null);
									}}
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-60",
										busy === choice.id && "animate-pulse",
									)}
								>
									<span
										className={cn(
											"flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
											choice.ticked &&
												"border-primary bg-primary text-primary-foreground",
										)}
									>
										{choice.ticked && <Check className="size-3" />}
									</span>
									{choice.face}
									<span className="min-w-0 flex-1 truncate font-mono">
										{choice.name}
									</span>
									{choice.detail && (
										<span className="shrink-0 text-xs text-muted-foreground">
											{choice.detail}
										</span>
									)}
								</button>
							</li>
						))
					)}
				</ul>
				{problem && <p className="px-1 text-sm text-destructive">{problem}</p>}
			</PopoverContent>
		</Popover>
	);
}
