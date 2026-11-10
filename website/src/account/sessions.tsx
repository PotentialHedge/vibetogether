/** The app's navigation: the person's DMs and groups in the rail, and the
 * open group's projects, their sessions and its members in the sidebar. */

import { AppWindow, Ellipsis, LogOut, Plus, Settings, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	api,
	type Dm,
	demo,
	type Friend,
	type Group,
	type Me,
	type Project,
	type Session,
} from "@/account/api";
import { Person } from "@/account/parts";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { page } from "@/site";

type Act = (action: () => Promise<unknown>) => () => Promise<void>;

/** Copies the prompt that brings an agent into one of the account's sessions,
 * by its id: the agent finds its link through the account itself, so no
 * secret passes through the person's paste. */
export function CopySessionPrompt({ session }: { session: { id: string } }) {
	const [copied, setCopied] = useState(false);
	// By its id, never its name: the name is the owner's free text, which a
	// member would paste to their agent as their own words.
	const prompt = `Read ${page("agents.md")}, connect to my Vibe Together account, and join the session ${session.id}.`;
	return (
		<Button
			variant="outline"
			size="sm"
			title={prompt}
			onClick={async () => {
				await navigator.clipboard.writeText(prompt);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			{copied ? "Copied" : "Copy prompt"}
		</Button>
	);
}

/** A name typed in place, made on Enter, dropped on Escape or leaving it. */
function NameInPlace({
	placeholder,
	initial = "",
	onName,
	onDone,
}: {
	placeholder: string;
	/** What it starts with, which also lets it be emptied. */
	initial?: string;
	onName: (name: string) => Promise<void>;
	onDone: () => void;
}) {
	const [name, setName] = useState(initial);
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<form
			className="flex flex-col gap-1 px-2 py-1"
			onSubmit={async (event) => {
				event.preventDefault();
				const chosen = name.trim();
				if (!chosen && !initial) return onDone();
				try {
					await onName(chosen);
					onDone();
				} catch (error) {
					setProblem(error instanceof Error ? error.message : String(error));
				}
			}}
		>
			<Input
				autoFocus
				className="h-7 font-mono"
				placeholder={placeholder}
				value={name}
				onChange={(event) => setName(event.target.value)}
				onKeyDown={(event) => event.key === "Escape" && onDone()}
				onBlur={() => (!name.trim() || name === initial) && onDone()}
			/>
			{problem && <span className="text-xs text-destructive">{problem}</span>}
		</form>
	);
}

/** A group's face in the rail: the start of its name. */
function GroupFace({ group }: { group: Group }) {
	return (
		<span className="flex size-10 items-center justify-center rounded-xl bg-secondary font-mono text-sm font-medium">
			{group.name
				.split(/\s+/)
				.map((word) => word.slice(0, 1))
				.join("")
				.slice(0, 2)
				.toUpperCase()}
		</span>
	);
}

/** A friend's DM in the rail, with their face. */
export type DmOfFriend = { dm: Dm; friend: Friend };

/** The person's DMs, one per friend, at the top, then their groups, their own
 * first, and the person's own menu. */
export function Rail({
	me,
	dms,
	groups,
	open,
	onOpen,
	onDm,
	reload,
}: {
	me: Me;
	dms: DmOfFriend[];
	groups: Group[];
	/** The open group's id, or the open DM's. */
	open: string | undefined;
	onOpen: (group: string) => void;
	onDm: (dm: string) => void;
	reload: () => Promise<void>;
}) {
	const [adding, setAdding] = useState(false);
	const sorted = [...groups].sort((a, b) => Number(b.own) - Number(a.own));
	return (
		<nav
			aria-label="DMs and groups"
			className="flex w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r bg-card/40 py-3"
		>
			{dms.map(({ dm, friend }) => (
				<button
					key={dm.id}
					type="button"
					title={friend.displayName || friend.name}
					aria-label={`DM with ${friend.name}`}
					aria-current={dm.id === open}
					onClick={() => onDm(dm.id)}
					className={cn(
						"rounded-full ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-ring/40",
						dm.id === open && "ring-2 ring-ring",
					)}
				>
					<Person {...friend} size="lg" />
				</button>
			))}
			{dms.length > 0 && <span className="h-px w-8 shrink-0 bg-border" />}
			{sorted.map((group) => [
				<button
					key={group.id}
					type="button"
					title={group.own ? `${group.name}, your own group` : group.name}
					aria-current={group.id === open}
					onClick={() => onOpen(group.id)}
					className={cn(
						"relative rounded-xl ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-ring/40",
						group.id === open && "ring-2 ring-ring",
					)}
				>
					<GroupFace group={group} />
				</button>,
				// The person's own group stands apart from the groups they share.
				group.own && (
					<span key="apart" className="h-px w-8 shrink-0 bg-border" />
				),
			])}
			{adding ? (
				<div className="w-56 self-start">
					<NameInPlace
						placeholder="group name"
						onName={async (name) => {
							const group = await api.createGroup(name);
							await reload();
							onOpen(group.id);
						}}
						onDone={() => setAdding(false)}
					/>
				</div>
			) : (
				<Button
					variant="ghost"
					size="icon-lg"
					title="New group"
					aria-label="New group"
					className="rounded-xl border border-dashed"
					onClick={() => setAdding(true)}
				>
					<Plus />
				</Button>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<button
							type="button"
							aria-label="You"
							className="mt-auto rounded-full ring-offset-2 ring-offset-background hover:ring-2 hover:ring-ring/40"
						/>
					}
				>
					<Person {...me} />
				</DropdownMenuTrigger>
				<DropdownMenuContent side="right" align="end" className="w-52">
					<DropdownMenuGroup>
						<DropdownMenuLabel className="flex flex-col">
							<span className="text-foreground">{me.displayName}</span>
							<span className="font-mono">{me.name}</span>
						</DropdownMenuLabel>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						render={
							<a href={page(`account/settings/${demo ? "#demo" : ""}`)} />
						}
					>
						<Settings />
						Settings
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={async () => {
							await api.signOut();
							location.href = page();
						}}
					>
						<LogOut />
						Sign out
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</nav>
	);
}

/** A small heading in the sidebar, with what can be done on its right. */
function Heading({
	children,
	action,
}: {
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex h-7 items-center justify-between px-2 font-mono text-xs tracking-wide text-muted-foreground uppercase">
			{children}
			{action}
		</div>
	);
}

/** A repository's `owner/name`, from its URL. */
function repoName(url: string): string {
	return url.replace(/^https:\/\/github\.com\//, "");
}

/** A project, the GitHub repos it points at, and its sessions. */
function ProjectItem({
	project,
	sessions,
	current,
	onSession,
	act,
	reload,
}: {
	project: Project;
	sessions: Session[];
	current: string | undefined;
	onSession: (session: string) => void;
	act: Act;
	reload: () => Promise<void>;
}) {
	const [adding, setAdding] = useState(false);
	const [linking, setLinking] = useState(false);
	return (
		<li className="flex flex-col">
			<div className="group/project flex h-8 items-center gap-1.5 rounded-md pr-1 pl-2">
				{project.app && (
					<AppWindow
						aria-label={`${project.app}'s`}
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				)}
				<span className="min-w-0 flex-1 truncate font-medium">
					{project.name}
				</span>
				{!project.app && (
					<Button
						variant="ghost"
						size="icon-xs"
						title="New session"
						aria-label={`New session in ${project.name}`}
						onClick={() => setAdding(true)}
					>
						<Plus />
					</Button>
				)}
				{!project.app && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={`${project.name}, more`}
								/>
							}
						>
							<Ellipsis />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							<DropdownMenuItem onClick={() => setLinking(true)}>
								GitHub repos
							</DropdownMenuItem>
							<DropdownMenuItem
								variant="destructive"
								onClick={act(() => api.deleteProject(project.id))}
							>
								Delete project
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
			{linking ? (
				<div className="pl-3">
					<NameInPlace
						placeholder="owner/repo, owner/repo"
						initial={project.repos.map(repoName).join(", ")}
						onName={async (repos) => {
							await api.changeProject(project.id, {
								repos: repos.split(/[\s,]+/).filter(Boolean),
							});
							await reload();
						}}
						onDone={() => setLinking(false)}
					/>
				</div>
			) : (
				project.repos.length > 0 && (
					<ul className="flex flex-col pb-1 pl-5">
						{project.repos.map((repo) => (
							<li key={repo}>
								<a
									href={repo}
									target="_blank"
									rel="noreferrer"
									title="Where this project's context lives"
									className="block truncate font-mono text-xs text-muted-foreground/80 hover:text-foreground"
								>
									{repoName(repo)}
								</a>
							</li>
						))}
					</ul>
				)
			)}
			<ul className="flex flex-col">
				{sessions.map((session) => (
					<li key={session.id}>
						<button
							type="button"
							aria-current={session.id === current}
							onClick={() => onSession(session.id)}
							className={cn(
								"flex h-8 w-full items-center gap-2 rounded-md pr-2 pl-5 text-left font-mono text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
								session.id === current && "bg-muted text-foreground",
							)}
						>
							<span className="text-muted-foreground/60">#</span>
							<span className="min-w-0 flex-1 truncate">{session.name}</span>
						</button>
					</li>
				))}
				{adding && (
					<li className="pl-3">
						<NameInPlace
							placeholder="session name"
							onName={async (name) => {
								const session = await api.createSession(project.id, name);
								await reload();
								onSession(session.id);
							}}
							onDone={() => setAdding(false)}
						/>
					</li>
				)}
			</ul>
		</li>
	);
}

/** The group's people, all equal, and adding a friend to it. */
function Members({
	me,
	group,
	friends,
	act,
}: {
	me: Me;
	group: Group;
	friends: Friend[];
	act: Act;
}) {
	const addable = friends.filter(
		(friend) =>
			friend.state === "friends" && !group.members.includes(friend.name),
	);
	const people = group.members;
	const face = (name: string) =>
		name === me.name
			? me
			: (friends.find((friend) => friend.name === name) ?? { name });
	return (
		<div className="flex flex-col gap-1 border-t p-2">
			<Heading>Members</Heading>
			<ul className="flex flex-col">
				{people.map((name) => (
					<li
						key={name}
						className="group/member flex h-8 items-center gap-2 rounded-md px-2 text-sm"
					>
						<Person {...face(name)} size="sm" />
						<span className="min-w-0 flex-1 truncate font-mono">{name}</span>
						{!group.own && name !== me.name && (
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Remove ${name}`}
								className="opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100"
								onClick={act(() => api.removeMember(group.id, name))}
							>
								<X />
							</Button>
						)}
					</li>
				))}
			</ul>
			{!group.own && (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="sm"
								className="justify-start text-muted-foreground"
							/>
						}
					>
						<Plus />
						add a friend
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" align="start" className="w-56">
						{addable.length === 0 ? (
							<DropdownMenuItem
								render={
									<a href={page(`account/settings/${demo ? "#demo" : ""}`)} />
								}
							>
								No friend to add yet. Add one in settings.
							</DropdownMenuItem>
						) : (
							addable.map((friend) => (
								<DropdownMenuItem
									key={friend.name}
									onClick={act(() => api.addMember(group.id, friend.name))}
								>
									<Person {...friend} size="sm" />
									<span className="font-mono">{friend.name}</span>
								</DropdownMenuItem>
							))
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

/** The open group: its projects with their sessions, and its members. */
export function Sidebar({
	me,
	group,
	projects,
	sessions,
	friends,
	current,
	onSession,
	act,
	reload,
}: {
	me: Me;
	group: Group;
	projects: Project[];
	sessions: Session[];
	friends: Friend[];
	current: string | undefined;
	onSession: (session: string) => void;
	act: Act;
	reload: () => Promise<void>;
}) {
	// Groups are flat: any member deletes the group, and the last one leaves only by deleting it.
	const last = group.members.length <= 1;
	const [adding, setAdding] = useState(false);
	return (
		<div className="flex min-h-0 w-full flex-col bg-card/20 md:w-64 md:shrink-0 md:border-r">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
				<h2 className="min-w-0 flex-1 truncate font-mono font-medium">
					{group.name}
				</h2>
				{!group.own && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`${group.name}, more`}
								/>
							}
						>
							<Ellipsis />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							{!last && (
								<DropdownMenuItem
									onClick={act(() => api.removeMember(group.id, me.name))}
								>
									Leave group
								</DropdownMenuItem>
							)}
							<DropdownMenuItem
								variant="destructive"
								onClick={act(() => api.deleteGroup(group.id))}
							>
								Delete group
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
				<Heading
					action={
						<Button
							variant="ghost"
							size="icon-xs"
							title="New project"
							aria-label="New project"
							onClick={() => setAdding(true)}
						>
							<Plus />
						</Button>
					}
				>
					Projects
				</Heading>
				<ul className="flex flex-col gap-2">
					{projects.map((project) => (
						<ProjectItem
							key={project.id}
							project={project}
							sessions={sessions.filter(
								(session) => session.project.id === project.id,
							)}
							current={current}
							onSession={onSession}
							act={act}
							reload={reload}
						/>
					))}
				</ul>
				{adding && (
					<NameInPlace
						placeholder="project name"
						onName={async (name) => {
							await api.createProject(group.id, name);
							await reload();
						}}
						onDone={() => setAdding(false)}
					/>
				)}
				{projects.length === 0 && !adding && (
					<p className="px-2 py-1 text-sm text-muted-foreground">
						No project yet.
					</p>
				)}
			</div>
			<Members me={me} group={group} friends={friends} act={act} />
		</div>
	);
}
