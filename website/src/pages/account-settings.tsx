/** The account's settings, one tab each: friends, logins, what agents
 * changed, the trash, and signing out and deleting the account. They are part of the
 * app, so the app's rail stays beside them. */

import {
	AppWindow,
	ArrowLeft,
	Bot,
	CircleUser,
	History,
	KeyRound,
	LogOut,
	Monitor,
	Server as ServerIcon,
	Trash2,
	Users,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
	type Activity,
	api,
	demo,
	type Login,
	type Seen,
	type Server,
	type ServerOtp,
	signedOut,
	type Trashed,
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
	trash: Trashed[];
	/** The other servers the home server keeps tokens for; null on a server
	 * without an owner, which keeps none. */
	others: Server[] | null;
};

async function load(given?: Seen): Promise<State> {
	const [seen, logins, activity, trash, others] = await Promise.all([
		given ?? api.seen(),
		api.logins(),
		api.activity(),
		api.trash(),
		api.servers().catch(() => null),
	]);
	return { ...seen, logins, activity, trash, others };
}

/** What each kind of login is, in plain words. */
const KIND = {
	browser: "browser sign-in",
	agent: "agent token",
	person: "person token",
	app: "app",
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

/** A place in the app as its query: what it opens, with the host of the
 * server it is on where that is not the home one. */
const placeQuery = (place: Record<string, string | undefined>) =>
	new URLSearchParams(
		Object.entries(place).filter((entry): entry is [string, string] =>
			Boolean(entry[1]),
		),
	).toString();

/** The app, with what the query opens. */
const app = (query = "") => page(`account/${query}${demo ? "#demo" : ""}`);

/** The settings' tabs, one thing each, kept in the address as `?tab=`. */
const TABS = [
	{ id: "friends", label: "Friends", icon: Users },
	{ id: "logins", label: "Logins", icon: KeyRound },
	{ id: "activity", label: "Activity", icon: History },
	{ id: "trash", label: "Trash", icon: Trash2 },
	{ id: "servers", label: "Servers", icon: ServerIcon },
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
	const { me, logins, activity, trash, others } = state;
	// The home server's friends: another server's are that server's.
	const friends = state.friends.filter((friend) => !friend.server);
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
					{TABS.filter(({ id }) => id !== "servers" || others).map(
						({ id, label, icon: Icon }) => (
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
						),
					)}
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
						line="Each way in to your account: a browser you signed in on, an agent token, which acts only for your agents, a person token, which acts as you, or an app, which sends and reads as you in your sessions. A token is made by an OTP you approve."
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
									) : login.kind === "app" ? (
										<AppWindow
											aria-label={KIND.app}
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

				{tab === "activity" && (
					<Pane title="Activity" line="What your agents changed, newest first.">
						<Rows empty="Nothing yet.">
							{activity.map((change) => (
								<Row
									key={`${change.created} ${change.login} ${change.operation} ${JSON.stringify(change.arguments)}`}
								>
									<Titled
										title={change.operation}
										detail={`${change.agent ?? change.name} · ${when.format(new Date(change.created))}${Object.keys(change.arguments).length ? ` · ${argumentsOf(change.arguments)}` : ""}`}
									/>
								</Row>
							))}
						</Rows>
					</Pane>
				)}

				{tab === "trash" && (
					<Pane
						title="Trash"
						line="What you and your agents deleted, with everything in it: it shows nowhere else until it is restored, and goes for good 30 days after it was deleted."
					>
						<Rows empty="The trash is empty.">
							{trash.map((item) => (
								<Row
									key={item.id}
									actions={
										<Button
											variant="ghost"
											size="sm"
											onClick={act(() => api.restore(item.id))}
										>
											Restore
										</Button>
									}
								>
									<Titled
										title={item.name}
										detail={[
											item.project
												? `session in ${item.group?.name} / ${item.project.name}`
												: item.group
													? `${item.kind} in ${item.group.name}`
													: item.kind,
											`deleted ${when.format(new Date(item.trashed))}${item.by ? ` by ${item.by}` : ""}`,
											`gone ${date.format(new Date(item.purged))}`,
										].join(" · ")}
									/>
								</Row>
							))}
						</Rows>
					</Pane>
				)}

				{tab === "servers" && others && (
					<ServersPane servers={others} reload={reload} />
				)}

				{tab === "account" && <AccountPane />}
			</main>
		</div>
	);
}

/** How long an OTP of another server waits for the person. */
const OTP_LIFETIME = 15 * 60_000;

/** The person's other servers, which this one keeps a token for each, so that
 * the app shows their groups and sessions beside this one's. Adding one asks
 * it for an OTP, which the person approves on that server's website. */
function ServersPane({
	servers,
	reload,
}: {
	servers: Server[];
	reload: () => Promise<void>;
}) {
	const [asked, setAsked] = useState<ServerOtp | null>(null);
	const { problem, act } = useActions(async () => {
		api.reachAgain();
		await reload();
	});
	return (
		<Pane
			title="Servers"
			line="Your other Vibe Together servers, such as the public one, whose groups and sessions show beside this one's. This server keeps a token for each."
			action={
				<AddByName
					placeholder="https://server"
					label="Add"
					onAdd={async (url) => {
						const otp = await api.addServer(url);
						setAsked(otp);
						const end = Date.now() + OTP_LIFETIME;
						const host = new URL(otp.link).host;
						while (Date.now() < end) {
							await new Promise((r) => setTimeout(r, 3000));
							const now = await api.servers();
							if (now.some((s) => new URL(s.url).host === host)) break;
						}
						setAsked(null);
						api.reachAgain();
						await reload();
					}}
				/>
			}
		>
			{problem && <p className="text-sm text-destructive">{problem}</p>}
			{asked && (
				<p className="text-sm text-pretty">
					Approve the OTP <code className="font-mono">{asked.code}</code> on{" "}
					<a
						href={asked.link}
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-4"
					>
						{new URL(asked.link).host}
					</a>
					, signed in there. This page waits for it.
				</p>
			)}
			<Rows empty="No other servers.">
				{servers.map((server) => (
					<Row
						key={server.id}
						actions={
							<Button
								variant="ghost"
								size="sm"
								onClick={act(() => api.removeServer(server.id))}
							>
								Remove
							</Button>
						}
					>
						<ServerIcon className="size-4 shrink-0 text-muted-foreground" />
						<Titled
							title={new URL(server.url).host}
							detail={`as ${server.account} · since ${date.format(new Date(server.added))}`}
						/>
					</Row>
				))}
			</Rows>
		</Pane>
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
	const { me, friends, groups, sessions, dms, servers } = state;
	const { act } = useActions(reload);
	const dmsOfFriends: DmOfFriend[] = dms.flatMap((dm) => {
		const friend = friends.find(
			(friend) => friend.name === dm.friend && friend.server === dm.server,
		);
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
					servers={servers}
					open={undefined}
					onOpen={(group) => {
						location.href = app(
							`?${placeQuery({ group: group.id, server: group.server })}`,
						);
					}}
					onAgents={() => {
						location.href = app("?agents");
					}}
					onDm={({ dm, friend }) => {
						location.href = app(
							`?${placeQuery({ dm: friend.name, server: dm.server })}`,
						);
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
		state && state !== "signed-out" ? state.revision : undefined,
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
