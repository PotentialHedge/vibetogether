/** Onboarding's half on the site: after signing in, one prompt with one OTP
 * that the person pastes into their agent, which does the rest. The calls are
 * the account service's invites and OTPs, the same operations agents use. */

import { useEffect, useState } from "react";
import { Unauthorized } from "@/account/api";
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

async function call<T>(method: string, path: string): Promise<T> {
	const response = await fetch(page(path), {
		method,
		credentials: "same-origin",
	});
	if (response.status === 401) throw new Unauthorized();
	const text = await response.text();
	if (!response.ok) throw new Error(text || response.statusText);
	return JSON.parse(text) as T;
}

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
	accept: (code: string) =>
		call<Accepted>("POST", `api/invites/${encodeURIComponent(code)}/accept`),
	otp: () => call<{ code: string; expires: string }>("POST", "api/otp"),
};

/** The prompt for the agent: the site's page for agents, the OTP, and what
 * to do once set up, such as joining the DM an invite led to. */
export function promptFor(otp: string, then?: string): string {
	const rest = then ? `, then ${then}` : "";
	return `Read ${page("agents.md")} and set me up with the OTP ${otp}${rest}.`;
}

/** Makes an OTP and shows the prompt with it, with a fresh one once it has
 * expired. */
export function AgentPrompt({ then }: { then?: string }) {
	const [otp, setOtp] = useState<{ code: string; expires: string } | null>(
		null,
	);
	const [problem, setProblem] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	const [copied, setCopied] = useState(false);
	const fresh = () => {
		setProblem(null);
		onboarding.otp().then(setOtp, (error) => setProblem(String(error)));
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, on the page's first showing
	useEffect(fresh, []);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	if (problem)
		return (
			<p className="text-sm text-destructive">
				No OTP could be made: {problem}
			</p>
		);
	if (!otp) return <div className="h-40" />;
	const left = Math.max(0, new Date(otp.expires).getTime() - now);
	const prompt = promptFor(otp.code, then);
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur">
				<pre
					className={`rounded-xl bg-background/80 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere ${left ? "" : "opacity-40"}`}
				>
					{prompt}
				</pre>
				{left ? (
					<Button
						size="xl"
						onClick={async () => {
							await navigator.clipboard.writeText(prompt);
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						}}
					>
						{copied ? "Copied" : "Copy the prompt for your agent"}
					</Button>
				) : (
					<Button size="xl" variant="outline" onClick={fresh}>
						The OTP expired: make a new one
					</Button>
				)}
			</div>
			<p className="px-2 text-sm text-pretty text-muted-foreground">
				Paste it into your agent, such as Claude Code. It signs in, keeps its
				token on your machine, and shows you what you can do next. The OTP works
				once, for{" "}
				{left
					? `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`
					: "no more time"}
				, and gives your agent everything you can do here: share it with no one
				else.
			</p>
		</section>
	);
}
