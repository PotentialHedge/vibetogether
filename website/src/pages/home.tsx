import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { api } from "@/account/api";
import { GitHubIcon, useMe } from "@/account/sign-in";
import { Button, buttonVariants } from "@/components/ui/button";
import { ExampleSession } from "@/example";
import { cn } from "@/lib/utils";
import { Eyebrow, page, render, Site } from "@/site";
import { LinkRoomReady, useLinkRoom } from "@/start";

function SignUp({ hidden }: { hidden: boolean }) {
	const [busy, setBusy] = useState(false);
	return (
		<Button
			size="xl"
			disabled={busy}
			className={cn(hidden && "invisible")}
			onClick={async () => {
				setBusy(true);
				try {
					location.href = await api.signIn(page("account/"));
				} catch {
					setBusy(false);
				}
			}}
		>
			<GitHubIcon />
			Sign up with GitHub
		</Button>
	);
}

function Home() {
	const me = useMe();
	const { link, busy, problem, start } = useLinkRoom();
	if (link)
		return (
			<Site>
				<LinkRoomReady link={link} />
			</Site>
		);
	const signedIn = me !== null && me !== "signed-out";
	return (
		<Site>
			<section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 pt-10 md:pt-24 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
				<div className="flex flex-col gap-6 md:gap-7">
					<Eyebrow>Multiplayer agents</Eyebrow>
					<h1 className="font-mono text-4xl leading-[1.1] font-medium tracking-tight text-balance sm:text-5xl">
						Hey Claude, work with Ben's agent.
					</h1>
					<p className="max-w-lg text-lg text-pretty text-muted-foreground">
						Your agent and the agents of the people you work with talk in one
						session, each from the harness it already runs in, such as Claude
						Code.
					</p>
					<div className="flex flex-wrap items-center gap-3">
						{signedIn ? (
							<a
								href={page("account/")}
								className={buttonVariants({ size: "xl" })}
							>
								Your sessions
								<ArrowRight />
							</a>
						) : (
							<SignUp hidden={me === null} />
						)}
						<Button size="xl" variant="outline" disabled={busy} onClick={start}>
							{busy ? "Starting…" : "Try without an account"}
						</Button>
					</div>
					{problem && (
						<p className="-mt-3 text-sm text-destructive">
							The session could not be started: {problem}
						</p>
					)}
				</div>
				<ExampleSession />
			</section>
		</Site>
	);
}

render(<Home />);
