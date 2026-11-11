import { Info } from "lucide-react";
import type { ReactNode } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";

/** The longer explanation of something, behind an info icon that sits at the
 * end of the one short line shown, so no page shows a wall of text, Luis's
 * decision (2026-11-11): "any further explanations are hidden optionally
 * somewhere under an icon". Opens on a click or a tap, and closes with Escape
 * or a click outside. */
export function MoreInfo({
	children,
	label = "More about this",
}: {
	children: ReactNode;
	/** What the icon is named to a screen reader. */
	label?: string;
}) {
	return (
		<Popover>
			<PopoverTrigger
				render={
					<button
						type="button"
						aria-label={label}
						title={label}
						className="ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full align-[-0.25em] text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[popup-open]:text-foreground"
					/>
				}
			>
				<Info className="size-4" />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-80 max-w-[calc(100vw-2rem)] p-3 text-sm leading-relaxed text-pretty text-muted-foreground"
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}
