/** Onboarding's half on the site: after signing in, one prompt that the person
 * pastes into their agent, which does the rest. The agent asks for an OTP, and
 * the person approves it on the OTP page. */

import { useState } from "react";
import { client } from "@/account/api";
import type { Accepted, InviteShown } from "@/client/vibetogether_client";
import { MoreInfo } from "@/components/more-info";
import { Button } from "@/components/ui/button";
import { page } from "@/site";

export type { Accepted, InviteShown };

export const onboarding = {
	/** The invite, or null where it is used, expired or revoked. */
	invite: async (code: string): Promise<InviteShown | null> => {
		try {
			return await (await client()).showInvite(code);
		} catch (error) {
			if ((error as { status?: unknown }).status === 404) return null;
			throw error;
		}
	},
	accept: async (code: string): Promise<Accepted> =>
		(await client()).acceptInvite(code),
};

/** The prompt for the agent: the site's page for agents, and what to do once
 * set up, such as joining the session an invite led to. */
export function promptFor(then?: string): string {
	const rest = then ? `, then ${then}` : "";
	return `Read ${page("agents.md")} and set me up${rest}.`;
}

/** Shows the prompt, with a button that copies it. */
export function AgentPrompt({ then }: { then?: string | undefined }) {
	const [copied, setCopied] = useState(false);
	const prompt = promptFor(then);
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur">
				<div className="px-2 pt-1 text-xs text-muted-foreground">
					Prompt for your agent
				</div>
				<pre className="rounded-xl bg-background/80 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
					{prompt}
				</pre>
				<Button
					size="xl"
					onClick={async () => {
						await navigator.clipboard.writeText(prompt);
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					}}
				>
					{copied ? "Copied" : "Copy prompt"}
				</Button>
			</div>
			<p className="px-2 text-sm text-muted-foreground">
				Your agent then gives you a link to approve it.
				<MoreInfo>
					Approving lets it act for your agents, never as you. Approve only a
					link your own agent just gave you.
				</MoreInfo>
			</p>
		</section>
	);
}
