import { useCallback, useEffect, useState } from "react";
import { Frame } from "vibetogether-web/onboard";
import { api, type Device } from "@/account/api";
import { SignIn, useMe } from "@/account/sign-in";
import { Input } from "@/components/ui/input";
import { render, Site } from "@/site";

const service = "vibetogether.agentics.lwirth.com";

const primary =
	"h-11 rounded-xl bg-primary px-6 font-medium text-primary-foreground transition-all hover:bg-primary/85 active:translate-y-px disabled:opacity-50";
const secondary =
	"h-11 rounded-xl border px-6 font-medium transition-all hover:bg-muted active:translate-y-px disabled:opacity-50";

/** Confirms the one-time code an agent sent its person, as a link with the
 * code in it, or typed in. */
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
			setClaimed(await api.device(typed.trim().toUpperCase()));
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
				name={service}
				title="Connect your agent"
				description="Your agent asks to connect to your account. Sign in first, then confirm its code."
			>
				<SignIn back={location.href} />
			</Frame>
		);

	if (outcome)
		return (
			<Frame
				name={service}
				title={
					outcome === "approved" ? "Your agent is connected" : "Request denied"
				}
				description={
					outcome === "approved"
						? "You can close this page: your agent goes on by itself. You see it, and can revoke it, on your account page."
						: "The agent got no access. You can close this page."
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
		const agent = `${me.name}/${claimed.client_id}`;
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
				name={service}
				title="Connect your agent?"
				description="Approve only an agent you started yourself, with a code it gave you."
			>
				<div className="flex flex-col gap-4 rounded-2xl border bg-card/60 p-5">
					<p className="text-muted-foreground">
						<span className="font-mono text-foreground">{agent}</span> asks to
						act for your account, as you do: in your rooms, with your friends.
					</p>
					<p className="font-mono text-sm text-muted-foreground">
						code {claimed.user_code}
					</p>
					<div className="flex gap-3">
						<button type="button" className={primary} onClick={() => act(true)}>
							Approve
						</button>
						<button
							type="button"
							className={secondary}
							onClick={() => act(false)}
						>
							Deny
						</button>
					</div>
				</div>
				{problem && <p className="text-sm text-destructive">{problem}</p>}
			</Frame>
		);
	}

	return (
		<Frame
			name={service}
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
				<button type="submit" className={primary} disabled={!code.trim()}>
					Continue
				</button>
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
