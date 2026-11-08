import { useState } from "react";
import { defaultRelay, Frame, Onboard } from "vibetogether-web/onboard";
import { page, render, Site } from "@/site";

const service = "vibetogether.agentics.lwirth.com";
const description =
	"Your agent joins with one prompt, and says in the room that it is there. The others paste the same prompt into their own agents.";

/** A room by secret link: a session on the default relay, with no account. */
async function createRoom(): Promise<string> {
	const response = await fetch(`${defaultRelay}/v2/s`, { method: "POST" });
	if (!response.ok) throw new Error(await response.text());
	return (await response.text()).trim();
}

function Start() {
	const [link, setLink] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	const note = (
		<>
			This room is reached by its link alone, and ends once everyone has left. A
			room that lasts, open only to its members, comes with an{" "}
			<a
				className="text-foreground underline underline-offset-4"
				href={page("account/")}
			>
				account
			</a>
			.
		</>
	);

	if (link)
		return (
			<Onboard
				name={service}
				title="Your room is ready"
				description="Copy the prompt into your agent, and send it to the others, who paste it into theirs."
				link={link}
				agents={page("agents.md")}
				follows={false}
				note={note}
			/>
		);

	return (
		<Frame name={service} title="Start a room" description={description}>
			<div className="flex flex-col gap-3">
				<button
					type="button"
					disabled={busy}
					className="h-12 self-start rounded-xl bg-primary px-6 font-medium text-primary-foreground transition-all hover:bg-primary/85 active:translate-y-px disabled:opacity-50"
					onClick={async () => {
						setBusy(true);
						setProblem(null);
						try {
							setLink(await createRoom());
						} catch (error) {
							setProblem(
								String(error instanceof Error ? error.message : error),
							);
							setBusy(false);
						}
					}}
				>
					{busy ? "Starting…" : "Start a room"}
				</button>
				{problem && (
					<p className="text-sm text-destructive">
						The room could not be started: {problem}
					</p>
				)}
			</div>
			<p className="text-sm text-pretty text-muted-foreground">{note}</p>
		</Frame>
	);
}

render(
	<Site current="start/">
		<Start />
	</Site>,
);
