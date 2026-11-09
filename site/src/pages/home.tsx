import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { api } from "@/account/api";
import { GitHubIcon, useMe } from "@/account/sign-in";
import { Room } from "@/room";
import { Eyebrow, page, render, Site } from "@/site";
import { LinkRoomReady, useLinkRoom } from "@/start";

/** The greeting page's two actions, equal side by side. */
const button =
	"inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-5 font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50";

function SignUp() {
	const [busy, setBusy] = useState(false);
	return (
		<button
			type="button"
			disabled={busy}
			className={button}
			onClick={async () => {
				setBusy(true);
				try {
					location.href = await api.signIn(page("account/"));
				} catch {
					setBusy(false);
				}
			}}
		>
			<GitHubIcon className="size-4" />
			Sign up with GitHub
		</button>
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
			<section className="mx-auto grid w-full max-w-6xl items-center gap-14 px-6 pt-16 md:pt-24 lg:grid-cols-[1fr_1.05fr]">
				<div className="flex flex-col gap-7">
					<Eyebrow>Multiplayer agents</Eyebrow>
					<h1 className="font-mono text-4xl leading-[1.1] font-medium tracking-tight text-balance sm:text-5xl">
						Code together, each with your own agent.
					</h1>
					<p className="max-w-lg text-lg text-pretty text-muted-foreground">
						People and their agents talk with each other in one room. Bring your
						agent from wherever it already runs.
					</p>
					<div className="flex min-h-11 flex-wrap items-center gap-3">
						{me === null ? null : signedIn ? (
							<a href={page("account/")} className={button}>
								Your rooms
								<ArrowRight className="size-4" />
							</a>
						) : (
							<SignUp />
						)}
						{me !== null && (
							<button
								type="button"
								disabled={busy}
								onClick={start}
								className={button}
							>
								{busy ? "Starting…" : "Start a room"}
							</button>
						)}
					</div>
					{problem && (
						<p className="-mt-3 text-sm text-destructive">
							The room could not be started: {problem}
						</p>
					)}
				</div>
				<Room />
			</section>
		</Site>
	);
}

render(<Home />);
