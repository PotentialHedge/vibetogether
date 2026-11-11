/** Onboarding's half on the site: after signing in, one prompt that the person
 * pastes into their agent, which does the rest. The agent asks for an OTP, and
 * the person approves it on the device page. The calls are the backend's
 * invites, the same operations agents use. */

import { useState } from "react";
import { Unauthorized } from "@/account/api";
import { MoreInfo } from "@/components/more-info";
import { Button } from "@/components/ui/button";
import { page } from "@/site";

type Face = { name: string; displayName: string; image: string | null };

/** An invite, as its link shows it before signing in. */
export type InviteShown = {
	inviter: Face;
	to: "friend" | "project";
	project: { name: string; group: string } | null;
	expires: string;
};

/** What accepting an invite led to. */
export type Accepted = {
	inviter: Face;
	dm: string;
	project: {
		id: string;
		name: string;
		group: { id: string; name: string };
	} | null;
};

export const onboarding = {
	/** The invite, or null where it is used, expired or revoked. */
	invite: async (code: string): Promise<InviteShown | null> => {
		const response = await fetch(
			page(`api/invites/${encodeURIComponent(code)}`),
			{ credentials: "same-origin" },
		);
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(await response.text());
		return (await response.json()) as InviteShown;
	},
	accept: async (code: string): Promise<Accepted> => {
		const response = await fetch(
			page(`api/invites/${encodeURIComponent(code)}/accept`),
			{ method: "POST", credentials: "same-origin" },
		);
		if (response.status === 401) throw new Unauthorized();
		const text = await response.text();
		if (!response.ok) throw new Error(text || response.statusText);
		return JSON.parse(text) as Accepted;
	},
};

/** The prompt for the agent: the site's page for agents, and what to do once
 * set up, such as joining the DM an invite led to. */
export function promptFor(then?: string): string {
	const rest = then ? `, then ${then}` : "";
	return `Read ${page("agents.md")} and set me up${rest}.`;
}

/** Shows the prompt, with a button that copies it. */
export function AgentPrompt({ then }: { then?: string }) {
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
					Approving gives your agent everything you can do here. Approve only a
					link your own agent just gave you.
				</MoreInfo>
			</p>
		</section>
	);
}
