import { useCallback, useEffect, useState } from "react";
import { api } from "@/account/api";
import { SignIn, useMe } from "@/account/sign-in";
import type { OtpShown } from "@/client/vibetogether_client";
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

/** What each kind of token may do, in plain words. */
const KIND = {
	agent: {
		what: "an agent token",
		does: "It acts only for your agents, never as you.",
	},
	person: {
		what: "a person token",
		does: "It acts as you, as a client of yours, such as a messenger: it can do everything you can do here.",
	},
} as const;

/** Approves or denies the OTP someone asked for a token with, as a link with
 * the code in it, or typed in. */
function OtpPage() {
	const me = useMe();
	const given = new URLSearchParams(location.search).get("code");
	const [code, setCode] = useState(given ?? "");
	const [shown, setShown] = useState<OtpShown | null>(null);
	const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	const show = useCallback(async (typed: string) => {
		setProblem(null);
		try {
			setShown(await api.showOtp(typed.trim().toUpperCase()));
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		}
	}, []);

	useEffect(() => {
		if (given && me && me !== "signed-out") show(given);
	}, [given, me, show]);

	if (me === null) return null;
	if (me === "signed-out")
		return (
			<Frame
				title="Approve a token"
				description="Sign in, then approve or deny it."
				info="An agent or a client of yours asks for a token with an OTP."
			>
				<SignIn back={location.href} />
			</Frame>
		);

	if (outcome)
		return (
			<Frame
				title={outcome === "denied" ? "Request denied" : "Token approved"}
				description={
					outcome === "denied"
						? "It got no access. You can close this page."
						: "You can close this page."
				}
				info={
					outcome === "denied"
						? undefined
						: "It goes on by itself. Revoke it any time in your settings, under Logins."
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

	if (shown) {
		const kind = KIND[shown.kind];
		const act = async (approve: boolean) => {
			try {
				await (approve ? api.approveOtp(shown.code) : api.denyOtp(shown.code));
				setOutcome(approve ? "approved" : "denied");
			} catch (error) {
				setProblem(error instanceof Error ? error.message : String(error));
			}
		};
		return (
			<Frame
				title={`Give ${shown.name} ${kind.what}?`}
				description={`${kind.does} Only if your own agent or client just gave you this code.`}
				info="It lasts until you revoke it in your settings, under Logins. If someone sent you this link, deny it."
			>
				<div className="flex flex-col gap-4 rounded-2xl border bg-card/60 p-5">
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
						<dt className="text-muted-foreground">name</dt>
						<dd>{shown.name}</dd>
						<dt className="text-muted-foreground">code</dt>
						<dd>{shown.code}</dd>
						<dt className="text-muted-foreground">asked</dt>
						<dd>{ago(shown.requested)}</dd>
						<dt className="text-muted-foreground">from</dt>
						<dd>{shown.from}</dd>
					</dl>
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
			title="Approve a token"
			description="Enter the code your agent or client gave you."
		>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					show(code);
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
		<OtpPage />
	</Site>,
);
