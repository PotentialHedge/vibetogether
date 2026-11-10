import { AppWindow, Monitor, Plug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Frame } from "ui/onboard";
import {
	type App,
	api,
	demo,
	type Friend,
	type Me,
	type Minted,
	type Session,
	type Token,
	Unauthorized,
} from "@/account/api";
import {
	AddByName,
	Empty,
	Panel,
	Person,
	Row,
	Titled,
	useActions,
} from "@/account/parts";
import { CopySessionPrompt, Sessions } from "@/account/sessions";
import { SignIn } from "@/account/sign-in";
import { Button } from "@/components/ui/button";
import { page, render, Site } from "@/site";

type State = {
	me: Me;
	sessions: Session[];
	friends: Friend[];
	tokens: Token[];
	apps: App[];
};

async function load(): Promise<State> {
	const [me, sessions, friends, tokens, apps] = await Promise.all([
		api.me(),
		api.sessions(),
		api.friends(),
		api.tokens(),
		api.apps(),
	]);
	return { me, sessions, friends, tokens, apps };
}

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function Dashboard({
	state,
	reload,
}: {
	state: State;
	reload: () => Promise<void>;
}) {
	const { me, sessions, friends, tokens, apps } = state;
	const { problem, act } = useActions(reload);
	const [minted, setMinted] = useState<Minted | null>(null);

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-14 px-6 pt-12 md:pt-16">
			<header className="flex flex-wrap items-center gap-4">
				<Person {...me} size="lg" />
				<div className="flex flex-col">
					<h1 className="text-xl font-medium">{me.displayName}</h1>
					<span className="font-mono text-sm text-muted-foreground">
						{me.name}
					</span>
				</div>
				<Button
					variant="ghost"
					className="ml-auto"
					onClick={async () => {
						await api.signOut();
						location.reload();
					}}
				>
					Sign out
				</Button>
			</header>
			{problem && <p className="-mt-8 text-sm text-destructive">{problem}</p>}

			<Sessions
				me={me}
				sessions={sessions.filter((session) => !session.app)}
				friends={friends}
				act={act}
				reload={reload}
			/>

			<Panel
				title="Friends"
				description="Two people are friends once each has added the other."
				action={
					<AddByName
						placeholder="github name"
						label="Add"
						onAdd={async (name) => {
							await api.addFriend(name);
							await reload();
						}}
					/>
				}
			>
				{friends.length === 0 ? (
					<Empty>No friends yet. Add someone by their GitHub name.</Empty>
				) : (
					friends.map((friend) => (
						<Row
							key={friend.name}
							actions={
								<>
									{friend.state === "asked" && (
										<span className="text-sm text-muted-foreground">
											waiting for them
										</span>
									)}
									{friend.state === "asking" && (
										<Button
											size="sm"
											onClick={act(() => api.addFriend(friend.name))}
										>
											Accept
										</Button>
									)}
									<Button
										variant="ghost"
										size="sm"
										onClick={act(() => api.removeFriend(friend.name))}
									>
										{friend.state === "asking" ? "Decline" : "Remove"}
									</Button>
								</>
							}
						>
							<Person {...friend} size="sm" />
							<span className="flex min-w-0 flex-col leading-tight">
								<span className="truncate">{friend.displayName}</span>
								<span className="font-mono text-xs text-muted-foreground">
									{friend.name}
								</span>
							</span>
						</Row>
					))
				)}
			</Panel>

			<Panel
				title="Apps"
				description="An app acts as you, such as a bridge to a messenger, until you revoke it. It manages its own sessions, and revoking it ends them."
			>
				{apps.length === 0 ? (
					<Empty>No app yet.</Empty>
				) : (
					apps.map((app) => (
						<div key={app.id} className="flex flex-col">
							<Row
								actions={
									<Button
										variant="ghost"
										size="sm"
										onClick={act(() => api.revokeApp(app.id))}
									>
										Revoke
									</Button>
								}
							>
								<AppWindow
									aria-hidden
									className="size-4 shrink-0 text-muted-foreground"
								/>
								<Titled
									title={app.name}
									detail={
										<>
											{app.for && <>{app.for} · </>}
											since {date.format(new Date(app.created))}
										</>
									}
								/>
							</Row>
							{sessions
								.filter((session) => session.app?.id === app.id)
								.map((session) => (
									<Row
										key={session.id}
										inset
										actions={<CopySessionPrompt session={session} />}
									>
										<span className="font-mono text-sm">{session.name}</span>
									</Row>
								))}
						</div>
					))
				)}
			</Panel>

			<Panel
				title="Tokens"
				description="A token connects the agents of a machine, or an MCP client, to your account, until you revoke it."
				action={
					<AddByName
						placeholder="machine name"
						label="Mint new token"
						onAdd={async (name) => {
							setMinted(await api.mint(name));
							await reload();
						}}
					/>
				}
			>
				{minted && <MintedToken minted={minted} />}
				{tokens.length === 0 ? (
					<Empty>No token yet.</Empty>
				) : (
					tokens.map((token) => (
						<Row
							key={token.id}
							actions={
								<Button
									variant="ghost"
									size="sm"
									onClick={act(() => api.revoke(token.id))}
								>
									Revoke
								</Button>
							}
						>
							{token.kind === "mcp" ? (
								<Plug
									aria-label="MCP client"
									className="size-4 shrink-0 text-muted-foreground"
								/>
							) : (
								<Monitor
									aria-label="machine"
									className="size-4 shrink-0 text-muted-foreground"
								/>
							)}
							<Titled
								title={token.name}
								detail={`${token.kind === "mcp" ? "MCP client" : "machine"} · since ${date.format(new Date(token.created))}`}
							/>
						</Row>
					))
				)}
			</Panel>
		</div>
	);
}

/** A token just minted, shown this once, with where to keep it. */
function MintedToken({ minted }: { minted: Minted }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex flex-col gap-3 bg-background/40 px-5 py-4">
			<p className="text-sm text-pretty">
				The token for <span className="font-mono">{minted.name}</span>, shown
				only now. Save it on that machine in{" "}
				<code className="font-mono">~/.config/vibetogether/token</code>, where
				its agents look for it. Don't paste it into a chat: it acts for your
				account.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<code className="min-w-0 flex-1 rounded-lg border bg-background/80 px-3 py-2 font-mono text-sm break-all">
					{minted.token}
				</code>
				<Button
					variant="outline"
					onClick={async () => {
						await navigator.clipboard.writeText(minted.token);
						setCopied(true);
					}}
				>
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
		</div>
	);
}

function Account() {
	const [state, setState] = useState<State | "signed-out" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const reload = useCallback(async () => {
		try {
			setState(await load());
		} catch (error) {
			if (error instanceof Unauthorized) setState("signed-out");
			else setProblem(error instanceof Error ? error.message : String(error));
		}
	}, []);
	useEffect(() => {
		reload();
	}, [reload]);

	if (problem)
		return (
			<p className="mx-auto max-w-4xl px-6 pt-16 text-destructive">
				The account could not be loaded: {problem}
			</p>
		);
	if (state === null) return null;
	if (state === "signed-out")
		return (
			<Frame
				title="Your account"
				description="Sign in to keep sessions that last, add friends, and see and revoke your tokens."
			>
				<SignIn back={demo ? "#demo" : page("account/")} />
				<p className="text-sm text-pretty text-muted-foreground">
					Your GitHub name becomes your name in sessions, and your agents take
					part under it, as <code className="font-mono">yourname/claude</code>.
					A session without an account needs none of this:{" "}
					<a
						className="text-foreground underline underline-offset-4"
						href={page()}
					>
						start one
					</a>
					.
				</p>
			</Frame>
		);
	return <Dashboard state={state} reload={reload} />;
}

render(
	<Site current="account/">
		<Account />
	</Site>,
);
