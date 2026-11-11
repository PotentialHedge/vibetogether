import { useCallback, useEffect, useState } from "react";
import { api, type Device } from "@/account/api";
import { SignIn, useMe } from "@/account/sign-in";
import { Frame } from "@/components/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { render, Site } from "@/site";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** How long ago `time` was, such as "2 minutes ago". */
function ago(time: string): string {
	const seconds = Math.round((new Date(time).getTime() - Date.now()) / 1000);
	if (Math.abs(seconds) < 60) return relative.format(seconds, "second");
	const minutes = Math.round(seconds / 60);
	if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
	return relative.format(Math.round(minutes / 60), "hour");
}

/** Confirms the OTP an agent or a bridge sent its person, as a link with the
 * code in it, or typed in. A bridge's lets it speak as the person. */
function DevicePage() {
	const me = useMe();
	const given = new URLSearchParams(location.search).get("user_code");
	const [code, setCode] = useState(given ?? "");
	const [claimed, setClaimed] = useState<Device | null>(null);
	const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	const claim = useCallback(async (typed: string) => {
		setProblem(null);
		try {
			const device = await api.device(typed.trim().toUpperCase());
			setClaimed(device);
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		}
	}, []);

	useEffect(() => {
		if (given && me && me !== "signed-out") claim(given);
	}, [given, me, claim]);

	if (me === null) return null;
	if (me === "signed-out")
		return (
			<Frame
				title="Connect your agent"
				description="An agent asks for your account with an OTP. Sign in first, then decide."
			>
				<SignIn back={location.href} />
			</Frame>
		);

	if (outcome)
		return (
			<Frame
				title={
					outcome === "denied"
						? "Request denied"
						: claimed?.bridge
							? "Linked"
							: "Your agent is connected"
				}
				description={
					outcome === "denied"
						? `The ${claimed?.bridge ? "bridge" : "agent"} got no access. You can close this page.`
						: claimed?.bridge
							? "Back to the chat. Revoke it any time in your settings."
							: "You can close this page: your agent goes on by itself. You see it, and can revoke it, on your account page."
				}
			>
				<a
					className="self-start text-sm underline underline-offset-4"
					href="../"
				>
					Your account
				</a>
			</Frame>
		);

	if (claimed) {
		const act = async (approve: boolean) => {
			try {
				await (approve
					? api.approve(claimed.user_code)
					: api.deny(claimed.user_code));
				setOutcome(approve ? "approved" : "denied");
			} catch (error) {
				setProblem(error instanceof Error ? error.message : String(error));
			}
		};
		return (
			<Frame
				title={
					claimed.bridge
						? `${claimed.client_id} wants to speak as you`
						: "Approve this code?"
				}
				description={
					claimed.bridge
						? "What you write through it reaches your sessions as you."
						: "An agent asks for your account with an OTP."
				}
			>
				<div className="flex flex-col gap-4 rounded-2xl border bg-card/60 p-5">
					{!claimed.bridge && (
						<p className="text-muted-foreground">
							The machine{" "}
							<span className="font-mono whitespace-nowrap text-foreground">
								{claimed.client_id}
							</span>{" "}
							asks to connect to your account. Every agent on it can then join
							your sessions as your agent, until you revoke it.
						</p>
					)}
					{claimed.bridge && (
						<p className="text-center font-mono text-3xl tracking-widest text-foreground">
							{claimed.user_code}
						</p>
					)}
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
						{claimed.bridge && claimed.for && (
							<>
								<dt className="text-muted-foreground">who</dt>
								<dd className="break-words">{claimed.for}</dd>
							</>
						)}
						{!claimed.bridge && (
							<>
								<dt className="text-muted-foreground">code</dt>
								<dd>{claimed.user_code}</dd>
							</>
						)}
						<dt className="text-muted-foreground">asked</dt>
						<dd>{claimed.requested ? ago(claimed.requested) : "unknown"}</dd>
						<dt className="text-muted-foreground">from</dt>
						<dd>{claimed.from ?? "unknown"}</dd>
					</dl>
					<p className="text-sm text-muted-foreground">
						{claimed.bridge
							? "Approve only if this is you, and your chat shows the same code."
							: "Approve only if your own agent gave you this code just now. If someone sent you this link, deny it."}
					</p>
					<div className="flex gap-3">
						<Button size="xl" onClick={() => act(true)}>
							Approve
						</Button>
						<Button size="xl" variant="outline" onClick={() => act(false)}>
							Deny
						</Button>
					</div>
				</div>
				{problem && <p className="text-sm text-destructive">{problem}</p>}
			</Frame>
		);
	}

	return (
		<Frame
			title="Connect your agent"
			description="Enter the code your agent gave you."
		>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					claim(code);
				}}
			>
				<Input
					autoFocus
					className="h-11 flex-1 font-mono text-base tracking-widest uppercase"
					placeholder="ABCD-EFGH"
					value={code}
					onChange={(event) => setCode(event.target.value)}
				/>
				<Button type="submit" size="xl" disabled={!code.trim()}>
					Continue
				</Button>
			</form>
			{problem && (
				<p className="text-sm text-destructive">
					The code was not accepted: {problem}
				</p>
			)}
		</Frame>
	);
}

render(
	<Site current="account/">
		<DevicePage />
	</Site>,
);
