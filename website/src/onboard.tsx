/** Onboarding's half on the site: after signing in, one prompt with one OTP
 * that the person pastes into their agent, which does the rest. The calls are
 * the account service's invites and OTPs, the same operations agents use. */

import { useEffect, useState } from "react";
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

type OtpState = {
	state: "pending" | "used" | "expired";
	machine: string | null;
};

/** Where the page's own OTP stands, or null where the service knows it no more,
 * which it does only once it has expired. */
async function otpState(code: string): Promise<OtpState | null> {
	const response = await fetch(page(`api/otp/${encodeURIComponent(code)}`), {
		credentials: "same-origin",
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(await response.text());
	return (await response.json()) as OtpState;
}

/** Makes an OTP and shows the prompt with it, with a fresh one once it has
 * expired. Once the agent has traded it, says so and goes on to the account. */
export function AgentPrompt({ then }: { then?: string }) {
	const [otp, setOtp] = useState<{ code: string; expires: string } | null>(
		null,
	);
	const [problem, setProblem] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	const [copied, setCopied] = useState(false);
	const [connected, setConnected] = useState<string | null>(null);
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
	const left = otp ? Math.max(0, new Date(otp.expires).getTime() - now) : 0;
	const waiting = otp !== null && left > 0 && connected === null;
	// Every 2 seconds while the OTP waits: whether the agent has traded it.
	useEffect(() => {
		if (!waiting || !otp) return;
		let stopped = false;
		const timer = setInterval(async () => {
			try {
				const state = await otpState(otp.code);
				if (stopped || state?.state !== "used") return;
				setConnected(state.machine ?? "");
			} catch {
				// The next look tries again.
			}
		}, 2000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [waiting, otp]);
	useEffect(() => {
		if (connected === null) return;
		const timer = setTimeout(() => location.assign(page("account/")), 2500);
		return () => clearTimeout(timer);
	}, [connected]);
	if (problem)
		return (
			<p className="text-sm text-destructive">
				No OTP could be made: {problem}
			</p>
		);
	if (!otp) return <div className="h-40" />;
	if (connected !== null)
		return (
			<section className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-6 shadow-2xl shadow-black/20">
				<p className="text-lg font-medium">
					<span className="text-emerald-400">✓</span> Your agent is connected
					{connected ? ` (${connected})` : ""}
				</p>
				<p className="text-sm text-muted-foreground">
					Taking you to{" "}
					<a className="underline underline-offset-4" href={page("account/")}>
						your account
					</a>
					…
				</p>
			</section>
		);
	const prompt = promptFor(otp.code, then);
	const clock = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur">
				<div className="flex items-center justify-between gap-2 px-2 pt-1 text-xs text-muted-foreground">
					<span>Prompt for your agent</span>
					<span
						className={`rounded-full border px-2 py-0.5 font-mono tabular-nums ${left ? "" : "border-destructive/50 text-destructive"}`}
						aria-live="off"
					>
						{left ? `expires in ${clock}` : "expired"}
					</span>
				</div>
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
						{copied ? "Copied" : "Copy prompt"}
					</Button>
				) : (
					<Button size="xl" variant="outline" onClick={fresh}>
						Expired: get a new one
					</Button>
				)}
			</div>
			<p className="px-2 text-sm text-muted-foreground">
				Works once. Share it with no one.
				<MoreInfo>
					The OTP gives your agent everything you can do here. This page moves
					on by itself once your agent is in.
				</MoreInfo>
			</p>
		</section>
	);
}
