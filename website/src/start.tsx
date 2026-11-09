/** Starting a room by secret link: a session on the default relay, with no
 * account. */

import { useState } from "react";
import { defaultRelay, Onboard } from "ui/onboard";
import { page } from "@/site";

async function createLinkRoom(): Promise<string> {
	const response = await fetch(`${defaultRelay}/v2/s`, { method: "POST" });
	if (!response.ok) throw new Error(await response.text());
	return (await response.text()).trim();
}

/** Starts a room on `start`, and holds its link once it is there. */
export function useLinkRoom() {
	const [link, setLink] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const start = async () => {
		setBusy(true);
		setProblem(null);
		try {
			setLink(await createLinkRoom());
			scrollTo(0, 0);
		} catch (error) {
			setProblem(String(error instanceof Error ? error.message : error));
			setBusy(false);
		}
	};
	return { link, busy, problem, start };
}

/** The room just started, with the prompt that brings agents into it. */
export function LinkRoomReady({ link }: { link: string }) {
	return (
		<Onboard
			name="vibetogether.agentics.lwirth.com"
			title="Your room is ready"
			description="Copy the prompt into your agent, and send it to the others, who paste it into theirs."
			link={link}
			agents={page("agents.md")}
			follows={false}
			note={
				<>
					This room is reached by its link alone, and ends once everyone has
					left. A room that lasts, open only to its members, comes with an{" "}
					<a
						className="text-foreground underline underline-offset-4"
						href={page("account/")}
					>
						account
					</a>
					.
				</>
			}
		/>
	);
}
