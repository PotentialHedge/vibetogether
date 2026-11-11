/** The account's settings, one tab each: friends, logins, what agents
 * changed, and signing out and deleting the account. */

import {
	ArrowLeft,
	CircleUser,
	History,
	KeyRound,
	LogOut,
	Monitor,
	Plug,
	Users,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
	type Activity,
	api,
	demo,
	type Friend,
	type Login,
	type Me,
	Unauthorized,
} from "@/account/api";
import {
	AddByName,
	Person,
	Row,
	Titled,
	useActions,
	useReloadOnChange,
} from "@/account/parts";
import { SignIn } from "@/account/sign-in";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { page, render, Site } from "@/site";

type State = {
	/** The version of everything the account sees, as it was loaded at. */
	version: string;
	me: Me;
	friends: Friend[];
	logins: Login[];
	activity: Activity[];
};

async function load(): Promise<State> {
	// First, so that a change while the rest loads shows as one more.
	const version = await api.version();
	const [me, friends, logins, activity] = await Promise.all([
		api.me(),
		api.friends(),
		api.logins(),
		api.activity(),
	]);
	return { version, me, friends, logins, activity };
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

const app = page(`account/${demo ? "#demo" : ""}`);

/** The settings' tabs, one thing each, kept in the address as `?tab=`. */
const TABS = [
	{ id: "friends", label: "Friends", icon: Users },
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
	const { me, friends, logins, activity } = state;
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
					<a
						href={app}
						aria-label="Back to the app"
						title="Back to the app"
						className="-ml-1 rounded-md p-1 text-muted-foreground hover:text-foreground"
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
						line="Each way in to your account: a browser you signed in on, a machine's agents, or an MCP client. Agents connect by asking you to approve their OTP."
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
												await api.revoke(login.id);
												if (login.current) location.href = page();
											})}
										>
											{login.current ? "Sign out" : "Revoke"}
										</Button>
									}
								>
									{login.kind === "mcp" ? (
										<Plug
											aria-label="MCP client"
											className="size-4 shrink-0 text-muted-foreground"
										/>
									) : (
										<Monitor
											aria-label={
												login.kind === "browser" ? "browser" : "machine"
											}
											className="size-4 shrink-0 text-muted-foreground"
										/>
									)}
									<Titled
										title={
											login.current ? `${login.name} (this one)` : login.name
										}
										detail={`${login.kind === "mcp" ? "MCP client" : login.kind === "browser" ? "browser" : "machine"} · since ${date.format(new Date(login.created))}`}
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
	useReloadOnChange(
		state && state !== "signed-out" ? state.version : undefined,
		reload,
	);

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
