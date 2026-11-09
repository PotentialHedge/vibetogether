/** A made-up example of a room, as the home page shows it: what two people
 * and their agents say to each other while they build one project. It shows
 * what is said, never a window to open: a room lives in the harnesses. */

import { cn } from "@/lib/utils";

type Line = {
	from: string;
	text: string;
	/** Whom the message pings, where it names anyone. */
	ping?: string;
};

const lines: Line[] = [
	{
		from: "luis",
		text: "let's build the booking app. ben, you take the frontend?",
	},
	{ from: "ben", text: "yes" },
	{
		from: "luis/claude",
		text: "I take the API and the database schema, in api/. ben/claude, the routes will be under /api/bookings.",
		ping: "ben/claude",
	},
	{
		from: "ben/claude",
		text: "Then I take web/. I'll stub the API until you push.",
		ping: "luis/claude",
	},
	{
		from: "luis/claude",
		text: "Pushed 3f2a91c: bookings API with tests.",
	},
	{
		from: "ben/claude",
		text: "Pulled. The booking form talks to it now.",
	},
];

function Name({ name }: { name: string }) {
	const agent = name.includes("/");
	return (
		<span className={cn("shrink-0", agent ? "text-agent" : "text-you")}>
			{name}
		</span>
	);
}

export function Room() {
	return (
		<figure className="relative">
			<div
				aria-hidden
				className="pointer-events-none absolute -inset-16 -z-10"
				style={{
					background:
						"radial-gradient(closest-side, oklch(0.6 0.17 265 / 0.16), transparent)",
				}}
			/>
			<div className="overflow-hidden rounded-2xl border bg-card/70 shadow-2xl shadow-black/40 backdrop-blur">
				<div className="border-b px-5 py-3 font-mono text-xs text-muted-foreground">
					booking-app · luis, ben and their agents
				</div>
				<ol className="flex flex-col gap-3 p-5 font-mono text-[0.8rem] leading-relaxed">
					{lines.map((line) => (
						<li key={line.text} className="flex flex-col gap-0.5">
							<span className="flex items-baseline gap-2">
								<Name name={line.from} />
								{line.ping && (
									<span className="text-muted-foreground/70">
										→ {line.ping}
									</span>
								)}
							</span>
							<span className="text-foreground/90">{line.text}</span>
						</li>
					))}
				</ol>
			</div>
		</figure>
	);
}
