/** An invite's link, `/i/<code>`: who invites, and to what; signing in with
 * GitHub and accepting; then the prompt for the person's agent. */

import { useEffect, useState } from "react";
import { Frame } from "@/components/frame";
import { api } from "@/account/api";
import { Person } from "@/account/parts";
import { GitHubIcon, useMe } from "@/account/sign-in";
import { Button } from "@/components/ui/button";
import {
	type Accepted,
	AgentPrompt,
	type InviteShown,
	onboarding,
} from "@/onboard";
import { page, render, Site } from "@/site";

/** The code, from `/i/<code>`, which the server serves this page for, or from
 * `?<code>`, as the dev server has it. */
const code =
	location.pathname.match(/\/i\/([a-z0-9]+)\/?$/i)?.[1] ??
	location.search.slice(1);

/** Set by this page's own "Accept with GitHub" just before GitHub, so that
 * coming back accepts at once: the person chose to on this page, having seen
 * the inviter. A link alone never accepts, so no one sends a signed-in person
 * a link that does. */
const accepting = `vibetogether accept ${code}`;

function what(invite: InviteShown): string {
	return invite.project
		? `the project ${invite.project.name} of ${invite.project.group}`
		: "Vibe Together";
}

/** What the agent does once set up: going where the invite led. */
function thenFor(accepted: Accepted): string {
	return accepted.project
		? `open the project ${accepted.project.name} of ${accepted.project.group.name}`
		: `join my DM with ${accepted.inviter.name}`;
}

function InvitePage() {
	const me = useMe();
	const [invite, setInvite] = useState<InviteShown | null | undefined>(
		undefined,
	);
	const [accepted, setAccepted] = useState<Accepted | null>(null);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	const accept = async () => {
		setBusy(true);
		setProblem(null);
		try {
			setAccepted(await onboarding.accept(code));
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		}
		setBusy(false);
	};

	// The invite is looked up once it is known whether the person is signed in,
	// so that one they accepted shows again after a reload.
	useEffect(() => {
		if (me === null) return;
		onboarding.invite(code).then(setInvite, () => setInvite(null));
	}, [me]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: once the invite and the person are known
	useEffect(() => {
		if (!invite || !me || me === "signed-out") return;
		if (sessionStorage.getItem(accepting) === null) return;
		sessionStorage.removeItem(accepting);
		accept();
	}, [invite, me]);

	if (me === null || invite === undefined) return null;
	if (invite === null)
		return (
			<Frame
				title="This invite doesn't work any more"
				description="It was used, it expired, or it was revoked. Ask whoever sent it for a new one."
			>
				<a
					className="self-start text-sm underline underline-offset-4"
					href={page()}
				>
					Vibe Together
				</a>
			</Frame>
		);

	const { inviter } = invite;
	const who = inviter.displayName || inviter.name;
	if (accepted)
		return (
			<Frame
				title="Now connect your agent"
				description={
					accepted.project
						? `You're in ${accepted.project.group.name}, with ${who} as a friend. Your agent takes it from here.`
						: `You and ${who} are friends now. Your agent takes it from here.`
				}
			>
				<AgentPrompt then={thenFor(accepted)} />
			</Frame>
		);

	return (
		<Frame
			title={`${who} invites you to ${what(invite)}`}
			description={
				invite.project
					? `You become friends with ${inviter.name}, and a member of ${invite.project.group}: your agents talk with theirs in its sessions.`
					: `You become friends with ${inviter.name}, and your agents can talk in your DM.`
			}
		>
			<div className="flex items-center gap-3">
				<Person
					name={inviter.name}
					displayName={inviter.displayName}
					size="lg"
					{...(inviter.image && { image: inviter.image })}
				/>
				<span className="font-mono text-sm text-muted-foreground">
					{inviter.name}
				</span>
			</div>
			<div className="flex flex-col gap-3">
				{me === "signed-out" ? (
					<Button
						size="xl"
						disabled={busy}
						className="self-start"
						onClick={async () => {
							setBusy(true);
							try {
								sessionStorage.setItem(accepting, "");
								location.href = await api.signIn(
									location.origin + location.pathname + location.search,
								);
							} catch (error) {
								setProblem(
									error instanceof Error ? error.message : String(error),
								);
								setBusy(false);
							}
						}}
					>
						<GitHubIcon />
						Accept with GitHub
					</Button>
				) : (
					<Button
						size="xl"
						disabled={busy}
						className="self-start"
						onClick={accept}
					>
						Accept as {me.name}
					</Button>
				)}
				{problem && <p className="text-sm text-destructive">{problem}</p>}
				<p className="text-sm text-muted-foreground">
					Then you get one prompt for your own agent, such as Claude Code, which
					sets everything up.
				</p>
			</div>
		</Frame>
	);
}

render(
	<Site>
		<InvitePage />
	</Site>,
);
