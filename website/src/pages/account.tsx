import { Monitor, Plug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Frame } from "ui/onboard";
import {
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
	useActions,
} from "@/account/parts";
import { Sessions } from "@/account/sessions";
import { SignIn } from "@/account/sign-in";
import { Button } from "@/components/ui/button";
import { page, render, Site } from "@/site";

const service = "vibetogether.agentics.lwirth.com";

type State = {
	me: Me;
	sessions: Session[];
	friends: Friend[];
	tokens: Token[];
};

async function load(): Promise<State> {
	const [me, sessions, friends, tokens] = await Promise.all([
		api.me(),
		api.sessions(),
		api.friends(),
		api.tokens(),
	]);
	return { me, sessions, friends, tokens };
}

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function Dashboard({
	state,
	reload,
}: {
	state: State;
	reload: () => Promise<void>;
}) {
	const { me, sessions, friends, tokens } = state;
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
				sessions={sessions}
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
						<Row key={friend.name}>
							<Person {...friend} size="sm" />
							<span className="flex flex-col leading-tight">
								<span>{friend.displayName}</span>
								<span className="font-mono text-xs text-muted-foreground">
									{friend.name}
								</span>
							</span>
							<span className="ml-auto flex items-center gap-2">
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
							</span>
						</Row>
					))
				)}
			</Panel>

			<Panel
				title="Tokens"
				description="A token connects an agent to your account, until you revoke it."
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
						<Row key={token.id}>
							<span className="flex items-center gap-2 font-mono">
								{token.kind === "mcp" ? (
									<Plug
										aria-label="MCP"
										className="size-4 text-muted-foreground"
									/>
								) : (
									<Monitor
										aria-label="machine"
										className="size-4 text-muted-foreground"
									/>
								)}
								{token.name}
							</span>
							<span className="text-sm text-muted-foreground">
								since {date.format(new Date(token.created))}
							</span>
							<Button
								variant="destructive"
								size="sm"
								className="ml-auto"
								onClick={act(() => api.revoke(token.id))}
							>
								Revoke
							</Button>
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
				name={service}
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
