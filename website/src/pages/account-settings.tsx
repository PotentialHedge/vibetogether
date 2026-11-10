/** The account's settings: tokens, apps, friends, what agents changed, signing
 * out and deleting the account. */

import { AppWindow, ArrowLeft, Monitor, Plug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	type Activity,
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
import { SignIn } from "@/account/sign-in";
import { Button } from "@/components/ui/button";
import { page, render, Site } from "@/site";

type State = {
	me: Me;
	sessions: Session[];
	friends: Friend[];
	tokens: Token[];
	apps: App[];
	activity: Activity[];
};

async function load(): Promise<State> {
	const [me, sessions, friends, tokens, apps, activity] = await Promise.all([
		api.me(),
		api.sessions(),
		api.friends(),
		api.tokens(),
		api.apps(),
		api.activity(),
	]);
	return { me, sessions, friends, tokens, apps, activity };
}

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const when = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

/** An operation's arguments, as `key value` pairs. */
const argumentsOf = (args: Record<string, unknown>) =>
	Object.entries(args)
		.map(
			([key, value]) =>
				`${key} ${typeof value === "string" ? value : JSON.stringify(value)}`,
		)
		.join(" · ");

/** How many sessions an app manages, in words. */
const count = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

const app = page(`account/${demo ? "#demo" : ""}`);

function Settings({
	state,
	reload,
}: {
	state: State;
	reload: () => Promise<void>;
}) {
	const { me, sessions, friends, tokens, apps, activity } = state;
	const { problem, act } = useActions(reload);
	const [minted, setMinted] = useState<Minted | null>(null);
	const sessionsOf = (id: string) =>
		count(sessions.filter((session) => session.app?.id === id).length);

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-14 px-6 pt-8 md:pt-12">
			<header className="flex flex-wrap items-center gap-4">
				<a
					href={app}
					aria-label="Back to the app"
					className="text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-5" />
				</a>
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
						location.href = page();
					}}
				>
					Sign out
				</Button>
			</header>
			{problem && <p className="-mt-8 text-sm text-destructive">{problem}</p>}

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

			<Panel
				title="Apps"
				description="An app acts as you, such as a bridge to a messenger, until you revoke it. It manages its own sessions, and revoking it ends them."
			>
				{apps.length === 0 ? (
					<Empty>
						No app yet. Your agent sets one up for you from{" "}
						<a
							className="text-foreground underline underline-offset-4"
							href={page("apps.md")}
						>
							apps.md
						</a>
						.
					</Empty>
				) : (
					apps.map((app) => (
						<Row
							key={app.id}
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
										{sessionsOf(app.id)} · since{" "}
										{date.format(new Date(app.created))}
									</>
								}
							/>
						</Row>
					))
				)}
			</Panel>

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
				title="Activity"
				description="What your agents changed in your account, newest first."
			>
				{activity.length === 0 ? (
					<Empty>Nothing yet.</Empty>
				) : (
					activity.map((change) => (
						<Row
							key={`${change.created} ${change.token} ${change.operation} ${JSON.stringify(change.arguments)}`}
						>
							<Titled
								title={change.operation}
								detail={`${change.agent} · ${when.format(new Date(change.created))}${Object.keys(change.arguments).length ? ` · ${argumentsOf(change.arguments)}` : ""}`}
							/>
						</Row>
					))
				)}
			</Panel>

			<DeleteAccount />
		</div>
	);
}

/** Deleting the account, after a second click that says what goes with it. */
function DeleteAccount() {
	const [asked, setAsked] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<section className="flex flex-col gap-3 border-t pt-8 pb-4">
			<h2 className="font-mono text-lg font-medium tracking-tight">
				Delete account
			</h2>
			<p className="max-w-xl text-sm text-pretty text-muted-foreground">
				This deletes your account with its tokens and DMs, and every group you
				are the last member of, with its projects and sessions. You leave the
				other groups. It can't be undone.
			</p>
			<div className="flex flex-wrap gap-2">
				{asked ? (
					<>
						<Button
							variant="destructive"
							onClick={async () => {
								try {
									await api.deleteAccount();
									location.href = page();
								} catch (error) {
									setProblem(
										error instanceof Error ? error.message : String(error),
									);
								}
							}}
						>
							Yes, delete my account
						</Button>
						<Button variant="ghost" onClick={() => setAsked(false)}>
							Cancel
						</Button>
					</>
				) : (
					<Button variant="destructive" onClick={() => setAsked(true)}>
						Delete account
					</Button>
				)}
			</div>
			{problem && <p className="text-sm text-destructive">{problem}</p>}
		</section>
	);
}

/** A token just minted, shown this once, as the command that keeps it where
 * the machine's agents look for it, readable by its user only, as
 * `agents.md` has an agent keep it. */
function MintedToken({ minted }: { minted: Minted }) {
	const [copied, setCopied] = useState(false);
	const command = `(umask 077; mkdir -p ~/.config/vibetogether && printf %s '${minted.token}' > ~/.config/vibetogether/token)`;
	return (
		<div className="flex flex-col gap-3 bg-background/40 px-5 py-4">
			<p className="text-sm text-pretty">
				The token for <span className="font-mono">{minted.name}</span>, shown
				only now. Run this in a terminal on that machine: it saves the token in{" "}
				<code className="font-mono">~/.config/vibetogether/token</code>,
				readable only by you, where its agents look for it. Don't paste it into
				a chat: it acts for your account.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<code className="min-w-0 flex-1 rounded-lg border bg-background/80 px-3 py-2 font-mono text-sm break-all">
					{command}
				</code>
				<Button
					variant="outline"
					onClick={async () => {
						await navigator.clipboard.writeText(command);
						setCopied(true);
					}}
				>
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
		</div>
	);
}

function Page() {
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
				The settings could not be loaded: {problem}
			</p>
		);
	if (state === null) return null;
	if (state === "signed-out")
		return (
			<div className="mx-auto max-w-md px-6 pt-16">
				<SignIn back={location.href} />
			</div>
		);
	return <Settings state={state} reload={reload} />;
}

render(
	<Site current="account/">
		<Page />
	</Site>,
);
