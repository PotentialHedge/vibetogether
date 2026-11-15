/** The account's settings, one tab each: friends, logins, what agents
 * changed, and signing out and deleting the account. They are part of the
 * app, so the app's rail stays beside them. */

import {
	ArrowLeft,
	Bot,
	CircleUser,
	History,
	KeyRound,
	LogOut,
	Monitor,
	Users,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
	type Activity,
	type Agent,
	api,
	demo,
	type Login,
	type Seen,
	signedOut,
} from "@/account/api";
import {
	AddByName,
	Person,
	Row,
	Titled,
	useActions,
	useReloadOnChange,
} from "@/account/parts";
import { type DmOfFriend, Rail } from "@/account/sessions";
import { SignIn } from "@/account/sign-in";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { page, render, Site } from "@/site";

type State = Seen & {
	logins: Login[];
	activity: Activity[];
	/** The account's agents, the archived included. */
	agents: Agent[];
};

async function load(given?: Seen): Promise<State> {
	const [seen, logins, activity, agents] = await Promise.all([
		given ?? api.seen(),
		api.logins(),
		api.activity(),
		api.agents(),
	]);
	return { ...seen, logins, activity, agents };
}

/** What each kind of login is, in plain words. */
const KIND = {
	browser: "browser sign-in",
	agent: "agent token",
	person: "person token",
} as const;

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

/** The app, with what the query opens. */
const app = (query = "") => page(`account/${query}${demo ? "#demo" : ""}`);

/** The settings' tabs, one thing each, kept in the address as `?tab=`. */
const TABS = [
	{ id: "friends", label: "Friends", icon: Users },
	{ id: "agents", label: "Agents", icon: Bot },
	{ id: "logins", label: "Logins", icon: KeyRound },
	{ id: "activity", label: "Activity", icon: History },
	{ id: "account", label: "Account", icon: CircleUser },
] as const;
type Tab = (typeof TABS)[number]["id"];

function tabOfAddress(): Tab {
	const tab = new URLSearchParams(location.search).get("tab");
	return TABS.find(({ id }) => id === tab)?.id ?? "friends";
}

/** One tab's content: its title, a line on what it is where that helps, and
 * what can be added on the right. */
function Pane({
	title,
	line,
	action,
	children,
}: {
	title: string;
	line?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-5">
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<div className="flex flex-col gap-1">
					<h2 className="font-mono text-lg font-medium tracking-tight">
						{title}
					</h2>
					{line && (
						<p className="text-sm text-pretty text-muted-foreground">{line}</p>
					)}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

/** The rows of a pane, or one quiet line where there are none. */
function Rows({
	empty,
	children,
}: {
	empty: ReactNode;
	children: ReactNode[];
}) {
	return children.length === 0 ? (
		<p className="text-sm text-muted-foreground">{empty}</p>
	) : (
		<div className="divide-y overflow-hidden rounded-xl border bg-card/50">
			{children}
		</div>
	);
}

function Settings({
	state,
	reload,
}: {
	state: State;
	reload: () => Promise<void>;
}) {
	const { me, friends, logins, activity, agents } = state;
	const { problem, act } = useActions(reload);
	const [tab, setTab] = useState<Tab>(tabOfAddress);
	useEffect(() => {
		const back = () => setTab(tabOfAddress());
		addEventListener("popstate", back);
		return () => removeEventListener("popstate", back);
	}, []);
	const open = (next: Tab) => {
		const query = new URLSearchParams(location.search);
		query.set("tab", next);
		history.pushState(
			null,
			"",
			`${location.pathname}?${query}${location.hash}`,
		);
		setTab(next);
	};
	const asking = friends.filter((friend) => friend.state === "asking").length;

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 pb-16 md:flex-row md:gap-12 md:pt-12">
			<aside className="flex shrink-0 flex-col gap-6 md:w-52">
				<div className="flex items-center gap-3">
					{/* On a phone, where the rail is hidden. */}
					<a
						href={app()}
						aria-label="Back to the app"
						title="Back to the app"
						className="-ml-1 rounded-md p-1 text-muted-foreground hover:text-foreground md:hidden"
					>
						<ArrowLeft className="size-5" />
					</a>
					<Person {...me} />
					<div className="flex min-w-0 flex-col leading-tight">
						<span className="truncate font-medium">{me.displayName}</span>
						<span className="truncate font-mono text-xs text-muted-foreground">
							{me.name}
						</span>
					</div>
				</div>
				<nav
					aria-label="Settings"
					className="-mx-6 flex gap-1 overflow-x-auto px-6 md:mx-0 md:flex-col md:px-0"
				>
					{TABS.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							aria-current={id === tab ? "page" : undefined}
							onClick={() => open(id)}
							className={cn(
								"flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
								id === tab && "bg-muted text-foreground",
							)}
						>
							<Icon className="size-4" />
							{label}
							{id === "friends" && asking > 0 && (
								<span className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
									{asking}
								</span>
							)}
						</button>
					))}
				</nav>
			</aside>

			<main className="flex min-w-0 flex-1 flex-col gap-4">
				{problem && <p className="text-sm text-destructive">{problem}</p>}

				{tab === "friends" && (
					<Pane
						title="Friends"
						line="You become friends once each of you has added the other."
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
						<Rows empty="No friends yet.">
							{friends.map((friend) => (
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
									<Titled
										title={friend.displayName || friend.name}
										detail={friend.name}
									/>
								</Row>
							))}
						</Rows>
					</Pane>
				)}

				{tab === "logins" && (
					<Pane
						title="Logins"
						line="Each way in to your account: a browser you signed in on, an agent token, which acts only for your agents, or a person token, which acts as you. A token is made by an OTP you approve."
					>
						<Rows empty="No logins.">
							{logins.map((login) => (
								<Row
									key={login.id}
									actions={
										<Button
											variant="ghost"
											size="sm"
											onClick={act(async () => {
												await api.revokeLogin(login.id);
												if (login.current) location.href = page();
											})}
										>
											{login.current ? "Sign out" : "Revoke"}
										</Button>
									}
								>
									{login.kind === "browser" ? (
										<Monitor
											aria-label={KIND.browser}
											className="size-4 shrink-0 text-muted-foreground"
										/>
									) : login.kind === "agent" ? (
										<Bot
											aria-label={KIND.agent}
											className="size-4 shrink-0 text-muted-foreground"
										/>
									) : (
										<KeyRound
											aria-label={KIND.person}
											className="size-4 shrink-0 text-muted-foreground"
										/>
									)}
									<Titled
										title={
											login.current ? `${login.name} (this one)` : login.name
										}
										detail={`${KIND[login.kind]} · since ${date.format(new Date(login.created))}`}
									/>
								</Row>
							))}
						</Rows>
					</Pane>
				)}

				{tab === "agents" && (
					<Pane
						title="Agents"
						line="Your agents, each created once and named by its id, which stays when it is renamed: awake or asleep while it receives. Your groups' members and your friends see which are awake or asleep."
						action={
							<AddByName
								placeholder="agent name"
								label="Create"
								onAdd={async (name) => {
									await api.createAgent(name);
									await reload();
								}}
							/>
						}
					>
						<Rows empty="No agents yet: an agent creates itself, or you create it here and give it its id.">
							{agents.map((agent) => (
								<AgentRow key={agent.id} agent={agent} act={act} />
							))}
						</Rows>
					</Pane>
				)}

				{tab === "activity" && (
					<Pane title="Activity" line="What your agents changed, newest first.">
						<Rows empty="Nothing yet.">
							{activity.map((change) => (
								<Row
									key={`${change.created} ${change.login} ${change.operation} ${JSON.stringify(change.arguments)}`}
								>
									<Titled
										title={change.operation}
										detail={`${change.agent} · ${when.format(new Date(change.created))}${Object.keys(change.arguments).length ? ` · ${argumentsOf(change.arguments)}` : ""}`}
									/>
								</Row>
							))}
						</Rows>
					</Pane>
				)}

				{tab === "account" && <AccountPane />}
			</main>
		</div>
	);
}

/** One agent: its name, id, presence and status, renamed in place, and
 * archived after a second click, since that can't be undone. */
function AgentRow({
	agent,
	act,
}: {
	agent: Agent;
	act: (action: () => Promise<unknown>) => () => Promise<void>;
}) {
	const [renaming, setRenaming] = useState(false);
	const [archiving, setArchiving] = useState(false);
	const archived = agent.presence === "archived";
	const reachable = agent.presence === "awake" || agent.presence === "asleep";
	const detail = [
		agent.id,
		archived
			? "archived"
			: reachable
				? agent.presence
				: `last seen ${agent.seen ? when.format(new Date(agent.seen)) : "never"}`,
		!archived &&
			agent.listening.length > 0 &&
			`in ${agent.listening.map((s) => s.name).join(", ")}`,
		agent.status,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<Row
			actions={
				archived ? undefined : renaming ? (
					<AddByName
						placeholder={agent.name.split("/")[1] ?? ""}
						label="Rename"
						onAdd={async (name) => {
							await act(() => api.renameAgent(agent.id, name))();
							setRenaming(false);
						}}
					/>
				) : archiving ? (
					<>
						<Button
							variant="destructive"
							size="sm"
							onClick={act(() => api.archiveAgent(agent.id))}
						>
							Archive for good
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setArchiving(false)}
						>
							Cancel
						</Button>
					</>
				) : (
					<>
						<Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
							Rename
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setArchiving(true)}
						>
							Archive
						</Button>
					</>
				)
			}
		>
			<span
				role="img"
				aria-label={agent.presence}
				className={cn(
					"size-2 shrink-0 rounded-full",
					agent.presence === "awake"
						? "bg-emerald-500"
						: agent.presence === "asleep"
							? "bg-amber-400"
							: "bg-muted-foreground/30",
				)}
			/>
			<span className={cn("min-w-0", archived && "opacity-50")}>
				<Titled title={agent.name} detail={detail} />
			</span>
		</Row>
	);
}

/** Signing out, and deleting the account after a second click that says what
 * goes with it. */
function AccountPane() {
	const [asked, setAsked] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<Pane title="Account">
			<div className="flex flex-col items-start gap-2">
				<Button
					variant="outline"
					onClick={async () => {
						await api.signOut();
						location.href = page();
					}}
				>
					<LogOut />
					Sign out
				</Button>
			</div>
			<div className="flex flex-col items-start gap-3 border-t pt-5">
				<p className="max-w-xl text-sm text-pretty text-muted-foreground">
					Deleting your account deletes its tokens and DMs, and every group you
					are the last member of. You leave the other groups. It can't be
					undone.
				</p>
				{asked ? (
					<div className="flex flex-wrap gap-2">
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
					</div>
				) : (
					<Button variant="destructive" onClick={() => setAsked(true)}>
						Delete account
					</Button>
				)}
				{problem && <p className="text-sm text-destructive">{problem}</p>}
			</div>
		</Pane>
	);
}

/** The settings beside the app's rail, whose groups and DMs open in the app. */
function InApp({
	state,
	reload,
}: {
	state: State;
	reload: () => Promise<void>;
}) {
	const { me, friends, groups, sessions, dms } = state;
	const { act } = useActions(reload);
	const dmsOfFriends: DmOfFriend[] = dms.flatMap((dm) => {
		const friend = friends.find((friend) => friend.name === dm.friend);
		return friend ? [{ dm, friend }] : [];
	});
	return (
		<div className="flex h-dvh overflow-hidden">
			<div className="hidden min-h-0 md:flex">
				<Rail
					me={me}
					requests={friends.filter((friend) => friend.state === "asking")}
					pinged={
						new Set(
							sessions.flatMap((s) =>
								s.pinged && s.group ? [s.group.id] : [],
							),
						)
					}
					dms={dmsOfFriends}
					groups={groups}
					open={undefined}
					onOpen={(id) => {
						location.href = app(`?group=${encodeURIComponent(id)}`);
					}}
					onDm={(id) => {
						const friend = dmsOfFriends.find(({ dm }) => dm.id === id)?.friend;
						if (friend)
							location.href = app(`?dm=${encodeURIComponent(friend.name)}`);
					}}
					act={act}
					reload={reload}
					settings
				/>
			</div>
			<div className="min-w-0 flex-1 overflow-y-auto">
				<Settings state={state} reload={reload} />
			</div>
		</div>
	);
}

function Page() {
	const [state, setState] = useState<State | "signed-out" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const reload = useCallback(async (seen?: Seen) => {
		try {
			setState(await load(seen));
		} catch (error) {
			if (signedOut(error)) setState("signed-out");
			else setProblem(error instanceof Error ? error.message : String(error));
		}
	}, []);
	useEffect(() => {
		reload();
	}, [reload]);
	useReloadOnChange(
		state && state !== "signed-out" ? state.version : undefined,
		reload,
	);

	if (problem)
		return (
			<Site current="account/">
				<p className="mx-auto max-w-4xl px-6 pt-16 text-destructive">
					The settings could not be loaded: {problem}
				</p>
			</Site>
		);
	if (state === null) return null;
	if (state === "signed-out")
		return (
			<Site current="account/">
				<div className="mx-auto max-w-md px-6 pt-16">
					<SignIn back={location.href} />
				</div>
			</Site>
		);
	return <InApp state={state} reload={reload} />;
}

render(<Page />);
