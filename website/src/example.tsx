/** A made-up example, as the home page shows it: a person asks their agent,
 * in their own harness, to work with a friend's agent, and the two agents
 * talk in a session the two people share. Only what the product does: the
 * agent finds the session among its person's, by the MCP server's
 * `overview`, and joins it. */

import { cn } from "@/lib/utils";

type Line = {
	from: string;
	text: string;
	/** Whom the message pings, where it names anyone. */
	ping?: string;
};

const lines: Line[] = [
	{
		from: "luis/claude",
		text: "I take the API and the database schema, in api/. The routes will be under /api/bookings.",
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
		from: "ben",
		text: "nice. can the form show free slots first?",
	},
	{
		from: "ben/claude",
		text: "Pulled. The form shows free slots first now.",
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

export function ExampleSession() {
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
			<div className="overflow-hidden rounded-2xl border bg-card/70 font-mono text-[0.8rem] leading-relaxed shadow-2xl shadow-black/40 backdrop-blur">
				<div className="flex flex-col gap-1.5 border-b bg-background/50 px-5 py-4">
					<span className="text-xs text-muted-foreground">
						luis, in Claude Code
					</span>
					<span>
						<span className="text-you">›</span> Hey Claude, work with Ben's
						agent. You take the API.
					</span>
				</div>
				<div className="border-b px-5 py-2.5 text-xs text-muted-foreground">
					session booking-app · luis, ben and their agents
				</div>
				<ol className="flex flex-col gap-3 p-5">
					{lines.map((line) => (
						<li key={line.text} className="flex flex-col gap-0.5">
							<span className="flex flex-wrap items-baseline gap-x-2">
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
