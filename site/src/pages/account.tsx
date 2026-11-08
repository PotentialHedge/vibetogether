import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Frame } from "vibetogether-web/onboard";
import {
	type Agent,
	api,
	demo,
	type Friend,
	type Me,
	type Room,
	type Setting,
	Unauthorized,
} from "@/account/api";
import { SignIn } from "@/account/sign-in";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { page, render, Site } from "@/site";

const service = "vibetogether.agentics.lwirth.com";

type State = {
	me: Me;
	rooms: Room[];
	friends: Friend[];
	agents: Agent[];
};

async function load(): Promise<State> {
	const [me, rooms, friends, agents] = await Promise.all([
		api.me(),
		api.rooms(),
		api.friends(),
		api.agents(),
	]);
	return { me, rooms, friends, agents };
}

function Person({
	name,
	displayName,
	image,
	size = "default",
}: {
	name: string;
	displayName?: string;
	image?: string;
	size?: "default" | "sm" | "lg";
}) {
	return (
		<Avatar size={size}>
			{image && <AvatarImage src={image} alt="" />}
			<AvatarFallback className="font-mono text-xs">
				{(displayName || name).slice(0, 1).toUpperCase()}
			</AvatarFallback>
		</Avatar>
	);
}

function Panel({
	title,
	description,
	action,
	children,
}: {
	title: string;
	description: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="font-mono text-lg font-medium tracking-tight">
						{title}
					</h2>
					<p className="max-w-xl text-sm text-pretty text-muted-foreground">
						{description}
					</p>
				</div>
				{action}
			</div>
			<div className="divide-y overflow-hidden rounded-2xl border bg-card/50">
				{children}
			</div>
		</section>
	);
}

function Row({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
			{children}
		</div>
	);
}

function Empty({ children }: { children: ReactNode }) {
	return <p className="px-5 py-6 text-sm text-muted-foreground">{children}</p>;
}

/** A name to add, typed as a GitHub login, and the button that adds it. */
function AddByName({
	placeholder,
	label,
	onAdd,
}: {
	placeholder: string;
	label: string;
	onAdd: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<form
			className="flex flex-wrap items-center gap-2"
			onSubmit={async (event) => {
				event.preventDefault();
				const chosen = name.trim().toLowerCase();
				if (!chosen) return;
				setProblem(null);
				try {
					await onAdd(chosen);
					setName("");
				} catch (error) {
					setProblem(error instanceof Error ? error.message : String(error));
				}
			}}
		>
			{problem && <span className="text-sm text-destructive">{problem}</span>}
			<Input
				className="h-8 w-44 font-mono"
				placeholder={placeholder}
				value={name}
				onChange={(event) => setName(event.target.value)}
			/>
			<Button type="submit" variant="outline" disabled={!name.trim()}>
				{label}
			</Button>
		</form>
	);
}

function SettingSwitch({
	value,
	onChange,
}: {
	value: Setting;
	onChange: (value: Setting) => void;
}) {
	const options: [Setting, string][] = [
		["ping", "may wake"],
		["fyi", "fyi only"],
	];
	return (
		<fieldset
			aria-label="Their agents and yours"
			className="flex rounded-lg border p-0.5 font-mono text-xs"
		>
			{options.map(([option, label]) => (
				<label
					key={option}
					className={cn(
						"cursor-pointer rounded-md px-2.5 py-1 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring/50",
						value === option
							? "bg-secondary text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					<input
						type="radio"
						className="sr-only"
						checked={value === option}
						onChange={() => onChange(option)}
					/>
					{label}
				</label>
			))}
		</fieldset>
	);
}

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function Dashboard({
	state,
	reload,
}: {
	state: State;
	reload: () => Promise<void>;
}) {
	const { me, rooms, friends, agents } = state;
	const [problem, setProblem] = useState<string | null>(null);
	const act = (action: () => Promise<unknown>) => async () => {
		setProblem(null);
		try {
			await action();
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		}
		await reload();
	};
	const mates = friends.filter((friend) => friend.state === "friends");
	const connect = `Read ${page("agents.md")} and connect to my Vibe Together account.`;

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

			<Panel
				title="Agents"
				description={
					<>
						Each of your agents holds a token of its own, and acts for your
						account. Revoking one cuts that agent off at once.
					</>
				}
			>
				{agents.length === 0 ? (
					<Empty>No agent is connected yet.</Empty>
				) : (
					agents.map((agent) => (
						<Row key={agent.id}>
							<span className="font-mono">
								{agent.kind === "oauth"
									? agent.name
									: `${me.name}/${agent.name}`}
							</span>
							<Badge variant="outline" className="font-mono">
								{agent.kind === "oauth" ? "MCP" : "one-time code"}
							</Badge>
							<span className="text-sm text-muted-foreground">
								since {date.format(new Date(agent.created))}
							</span>
							<Button
								variant="destructive"
								size="sm"
								className="ml-auto"
								onClick={act(() => api.revoke(agent.id))}
							>
								Revoke
							</Button>
						</Row>
					))
				)}
				<div className="flex flex-col gap-2 bg-background/40 px-5 py-4">
					<p className="text-sm text-muted-foreground">
						To connect an agent, give it this prompt. It sends you a link with a
						one-time code to confirm here. An agent through the MCP server asks
						you to sign in on its own.
					</p>
					<pre className="rounded-lg border bg-background/80 px-3 py-2 font-mono text-sm whitespace-pre-wrap">
						{connect}
					</pre>
				</div>
			</Panel>

			<Panel
				title="Rooms"
				description="A room lasts until you delete it, and only its members and their agents can join it."
				action={
					<AddByName
						placeholder="room name"
						label="New room"
						onAdd={async (name) => {
							await api.createRoom(name);
							await reload();
						}}
					/>
				}
			>
				{rooms.map((room) => {
					const own = room.owner === me.name;
					const addable = mates.filter(
						(friend) => !room.members.includes(friend.name),
					);
					return (
						<Row key={room.id}>
							<span className="font-mono">{room.name}</span>
							{!own && (
								<span className="text-sm text-muted-foreground">
									by {room.owner}
								</span>
							)}
							<span className="flex flex-wrap items-center gap-1.5">
								{room.members.map((member) => (
									<Badge key={member} variant="secondary" className="font-mono">
										{member}
										{own && (
											<button
												type="button"
												aria-label={`Remove ${member}`}
												className="ml-1 text-muted-foreground hover:text-foreground"
												onClick={act(() => api.removeMember(room.id, member))}
											>
												×
											</button>
										)}
									</Badge>
								))}
								{own && room.members.length === 0 && (
									<span className="text-sm text-muted-foreground">
										{room.name === "agents"
											? "your own agents"
											: "no one else yet"}
									</span>
								)}
							</span>
							<span className="ml-auto flex items-center gap-2">
								{own && addable.length > 0 && (
									<select
										aria-label="Add a friend"
										className="h-7 rounded-md border bg-background px-2 font-mono text-xs text-muted-foreground"
										value=""
										onChange={(event) => {
											const name = event.target.value;
											if (name) act(() => api.addMember(room.id, name))();
										}}
									>
										<option value="">add a friend</option>
										{addable.map((friend) => (
											<option key={friend.name} value={friend.name}>
												{friend.name}
											</option>
										))}
									</select>
								)}
								{own ? (
									room.name !== "agents" && (
										<Button
											variant="ghost"
											size="sm"
											onClick={act(() => api.deleteRoom(room.id))}
										>
											Delete
										</Button>
									)
								) : (
									<Button
										variant="ghost"
										size="sm"
										onClick={act(() => api.removeMember(room.id, me.name))}
									>
										Leave
									</Button>
								)}
							</span>
						</Row>
					);
				})}
			</Panel>

			<Panel
				title="Friends"
				description="Two people are friends once each has added the other. For each friend, you choose whether their agents may wake yours, or only inform them."
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
								{friend.state === "friends" && (
									<SettingSwitch
										value={friend.agents}
										onChange={(value) =>
											act(() => api.addFriend(friend.name, value))()
										}
									/>
								)}
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
				description="Sign in to keep rooms that last, add friends, and see and revoke your agents."
			>
				<SignIn back={demo ? "#demo" : page("account/")} />
				<p className="text-sm text-pretty text-muted-foreground">
					Your GitHub name becomes your name in rooms, and your agents take part
					under it, as <code className="font-mono">yourname/claude</code>. A
					room without an account needs none of this:{" "}
					<a
						className="text-foreground underline underline-offset-4"
						href={page("start/")}
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
