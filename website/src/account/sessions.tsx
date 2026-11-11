/** The app's navigation: the person's DMs and groups in the rail, and the
 * open group's projects, their sessions and its members in the sidebar. */

import { Ellipsis, LogOut, Plus, Settings, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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

/** Naming something new, or changing what it holds, in a small dialog: made
 * with Enter or the button, dropped with Escape or Cancel. */
function NameDialog({
	open,
	onOpenChange,
	title,
	description,
	label,
	placeholder,
	initial = "",
	onName,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: ReactNode;
	/** What the button says, such as "Create". */
	label: string;
	placeholder: string;
	/** What it starts with, which also lets it be emptied. */
	initial?: string;
	onName: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState(initial);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (open) {
			setName(initial);
			setProblem(null);
		}
	}, [open, initial]);
	const chosen = name.trim();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					className="flex flex-col gap-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!chosen && !initial) return;
						setBusy(true);
						setProblem(null);
						try {
							await onName(chosen);
							onOpenChange(false);
						} catch (error) {
							setProblem(
								error instanceof Error ? error.message : String(error),
							);
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						{description && (
							<DialogDescription>{description}</DialogDescription>
						)}
					</DialogHeader>
					<Input
						autoFocus
						className="font-mono"
						placeholder={placeholder}
						value={name}
						maxLength={100}
						onChange={(event) => setName(event.target.value)}
					/>
					{problem && <p className="text-sm text-destructive">{problem}</p>}
					<DialogFooter>
						<DialogClose render={<Button variant="ghost" type="button" />}>
							Cancel
						</DialogClose>
						<Button type="submit" disabled={busy || (!chosen && !initial)}>
							{label}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Asking before something is deleted for good, since nothing brings it back. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	label,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	/** What the button says, such as "Delete project". */
	label: string;
	onConfirm: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" type="button" />}>
						Cancel
					</DialogClose>
					<Button
						variant="destructive"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await onConfirm();
							} finally {
								setBusy(false);
								onOpenChange(false);
							}
						}}
					>
						{label}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A group's face in the rail: the start of its name, by characters rather
 * than UTF-16 units, so that an emoji stays whole. */
function GroupFace({ group }: { group: Group }) {
	return (
		<span className="flex size-10 items-center justify-center rounded-xl bg-secondary font-mono text-sm font-medium">
			{group.name
				.split(/\s+/)
				.filter(Boolean)
				.map((word) => Array.from(word)[0])
				.slice(0, 2)
				.join("")
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
					aria-label={group.name}
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
			<Button
				variant="ghost"
				size="icon-lg"
				title="New group"
				aria-label="New group"
				className="size-10 shrink-0 rounded-xl border border-dashed"
				onClick={() => setAdding(true)}
			>
				<Plus />
			</Button>
			<NameDialog
				open={adding}
				onOpenChange={setAdding}
				title="New group"
				description="A group is people working together, with its projects. You can add friends to it once it exists."
				label="Create group"
				placeholder="Potential Hedge"
				onName={async (name) => {
					const group = await api.createGroup(name);
					await reload();
					onOpen(group.id);
				}}
			/>
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
	const [deleting, setDeleting] = useState(false);
	return (
		<li className="flex flex-col">
			<div className="group/project flex h-8 items-center gap-1.5 rounded-md pr-1 pl-2">
				<span
					className="min-w-0 flex-1 truncate font-medium"
					title={project.name}
				>
					{project.name}
				</span>
				<Button
					variant="ghost"
					size="icon-xs"
					title="New session"
					aria-label={`New session in ${project.name}`}
					onClick={() => setAdding(true)}
				>
					<Plus />
				</Button>
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
							onClick={() => setDeleting(true)}
						>
							Delete project
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${project.name}?`}
				description={
					sessions.length === 0
						? "It has no sessions."
						: `${sessions.length === 1 ? "Its session goes" : `Its ${sessions.length} sessions go`} with it, for everyone in the group.`
				}
				label="Delete project"
				onConfirm={act(() => api.deleteProject(project.id))}
			/>
			<NameDialog
				open={linking}
				onOpenChange={setLinking}
				title={`GitHub repos of ${project.name}`}
				description="Where the project's context lives. Agents that join its sessions are told of them. Separate several with commas."
				label="Save"
				placeholder="owner/repo, owner/repo"
				initial={project.repos.map(repoName).join(", ")}
				onName={async (repos) => {
					await api.changeProject(project.id, {
						repos: repos.split(/[\s,]+/).filter(Boolean),
					});
					await reload();
				}}
			/>
			{project.repos.length > 0 && (
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
			)}
			<ul className="flex flex-col">
				{sessions.map((session) => (
					<li key={session.id}>
						<button
							type="button"
							aria-current={session.id === current}
							title={session.name}
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
				{sessions.length === 0 && (
					<li>
						<button
							type="button"
							onClick={() => setAdding(true)}
							className="flex h-8 w-full items-center rounded-md pr-2 pl-5 text-left text-sm text-muted-foreground/70 hover:text-foreground"
						>
							+ new session
						</button>
					</li>
				)}
			</ul>
			<NameDialog
				open={adding}
				onOpenChange={setAdding}
				title={`New session in ${project.name}`}
				description="A session is where you and your agents talk. Its group's members and their agents can join it."
				label="Create session"
				placeholder="session name"
				onName={async (name) => {
					const session = await api.createSession(project.id, name);
					await reload();
					onSession(session.id);
				}}
			/>
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
						<span className="min-w-0 flex-1 truncate font-mono" title={name}>
							{name}
						</span>
						{!group.own && name !== me.name && (
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Remove ${name}`}
								// Shown on hover where there is one, always on a touch screen.
								className="[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/member:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
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
	const [deleting, setDeleting] = useState(false);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card/20 md:w-64 md:flex-none md:shrink-0 md:border-r">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
				<h2
					className="min-w-0 flex-1 truncate font-mono font-medium"
					title={group.name}
				>
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
								onClick={() => setDeleting(true)}
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
				<NameDialog
					open={adding}
					onOpenChange={setAdding}
					title={`New project in ${group.name}`}
					description="A project holds sessions, and can point at the GitHub repos where its context lives."
					label="Create project"
					placeholder="project name"
					onName={async (name) => {
						await api.createProject(group.id, name);
						await reload();
					}}
				/>
				{projects.length === 0 && (
					<div className="flex flex-col items-start gap-2 px-2 py-2 text-sm text-muted-foreground">
						<p>No project yet. A project holds sessions.</p>
						<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
							<Plus />
							New project
						</Button>
					</div>
				)}
			</div>
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${group.name}?`}
				description="Its projects and their sessions go with it, for every member."
				label="Delete group"
				onConfirm={act(() => api.deleteGroup(group.id))}
			/>
			<Members me={me} group={group} friends={friends} act={act} />
		</div>
	);
}
