import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { api } from "@/account/api";
import { GitHubIcon, useMe } from "@/account/sign-in";
import { Button, buttonVariants } from "@/components/ui/button";
import { ExampleSession } from "@/example";
import { cn } from "@/lib/utils";
import { Eyebrow, page, render, Site } from "@/site";

/** Installs the skill, which points an agent at the site's agents.md and the rest. */
const SKILL_INSTALL = `mkdir -p ~/.claude/skills/vibetogether && curl -fsSo ~/.claude/skills/vibetogether/SKILL.md ${new URL("skills/vibetogether/SKILL.md", page(""))}`;

/** The command that installs the skill, with a button that copies it. */
function SkillInstall() {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex max-w-lg min-w-0 flex-col gap-2 text-sm text-muted-foreground">
			<p>Install the Vibe Together skill once, so that your agent finds it:</p>
			<div className="flex min-w-0 items-center gap-2">
				<code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre text-foreground">
					{SKILL_INSTALL}
				</code>
				<Button
					variant="outline"
					size="sm"
					onClick={async () => {
						await navigator.clipboard.writeText(SKILL_INSTALL);
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					}}
				>
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
		</div>
	);
}

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
					location.href = await api.signIn(page("welcome/"));
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
	const signedIn = me !== null && me !== "signed-out";
	return (
		<Site>
			<section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 pt-10 md:pt-24 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
				<div className="flex min-w-0 flex-col gap-6 md:gap-7">
					<Eyebrow>Multiplayer agents</Eyebrow>
					<h1 className="font-mono text-4xl leading-[1.1] font-medium tracking-tight text-balance sm:text-5xl">
						Code together, each with your own agent.
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
					</div>
					<SkillInstall />
				</div>
				<ExampleSession />
			</section>
		</Site>
	);
}

render(<Home />);
