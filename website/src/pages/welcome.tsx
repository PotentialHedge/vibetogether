/** Where signing up from the greeting page lands: the prompt for the person's
 * agent, which sets everything up and shows what comes next. */

import { SignIn, useMe } from "@/account/sign-in";
import { Frame } from "@/components/frame";
import { AgentPrompt } from "@/onboard";
import { page, render, Site } from "@/site";

function Welcome() {
	const me = useMe();
	if (me === null) return null;
	if (me === "signed-out")
		return (
			<Frame
				title="Connect your agent"
				description="Sign in with GitHub, and you get one prompt for your agent, which sets everything up."
			>
				<SignIn back={location.href} />
			</Frame>
		);
	return (
		<Frame
			title={`Welcome, ${me.name}`}
			description="Your agent does the rest: it invites your friends, starts projects and joins sessions, each when you ask."
		>
			<AgentPrompt />
			<a
				className="self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
				href={page("account/")}
			>
				Your account
			</a>
		</Frame>
	);
}

render(
	<Site current="welcome/">
		<Welcome />
	</Site>,
);
