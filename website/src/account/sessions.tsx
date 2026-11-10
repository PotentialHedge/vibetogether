/** The account's groups, with their projects and sessions, and making new
 * ones. */

import { useState } from "react";
import {
	api,
	demo,
	type Friend,
	type Group,
	type Me,
	type Open,
	type Project,
	type Session,
} from "@/account/api";
import { AddByName, Empty, Panel, Row, Titled } from "@/account/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { page } from "@/site";

/** Copies the prompt that brings an agent into one of the account's sessions,
 * by its id: the agent finds its link through the account itself, so no
 * secret passes through the person's paste. */
export function CopySessionPrompt({ session }: { session: Session }) {
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

/** Whom a session is open to, as its group's owner sets it. */
function OpenSwitch({
	value,
	onChange,
}: {
	value: Open;
	onChange: (value: Open) => void;
}) {
	const options: [Open, string][] = [
		["members", "members only"],
		["link", "open by link"],
	];
	return (
		<fieldset
			aria-label="Who may join"
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

function SessionRow({
	me,
	session,
	isOwner,
	act,
}: {
	me: Me;
	session: Session;
	isOwner: boolean;
	act: (action: () => Promise<unknown>) => () => Promise<void>;
}) {
	return (
		<Row
			inset
			actions={
				<>
					{isOwner ? (
						<OpenSwitch
							value={session.open}
							onChange={(open) =>
								act(() => api.changeSession(session.id, { open }))()
							}
						/>
					) : (
						session.open === "link" && (
							<span className="font-mono text-xs text-muted-foreground">
								open by link
							</span>
						)
					)}
					<CopySessionPrompt session={session} />
					{(isOwner || session.creator === me.name) && (
						<Button
							variant="ghost"
							size="sm"
							onClick={act(() => api.deleteSession(session.id))}
						>
							Delete
						</Button>
					)}
				</>
			}
		>
			<a
				href={page(
					`account/session/?id=${encodeURIComponent(session.id)}${demo ? "#demo" : ""}`,
				)}
				title="Read the session"
				className="truncate font-mono underline-offset-4 hover:underline"
			>
				{session.name}
			</a>
		</Row>
	);
}

/** A project, and its sessions. */
function ProjectRows({
	me,
	project,
	sessions,
	isOwner,
	act,
	reload,
}: {
	me: Me;
	project: Project;
	sessions: Session[];
	isOwner: boolean;
	act: (action: () => Promise<unknown>) => () => Promise<void>;
	reload: () => Promise<void>;
}) {
	return (
		<div className="flex flex-col divide-y">
			<Row
				actions={
					<>
						<AddByName
							placeholder="session name"
							label="New session"
							onAdd={async (name) => {
								await api.createSession(project.id, name);
								await reload();
							}}
						/>
						{isOwner && (
							<Button
								variant="ghost"
								size="sm"
								onClick={act(() => api.deleteProject(project.id))}
							>
								Delete
							</Button>
						)}
					</>
				}
			>
				<Titled title={project.name} />
			</Row>
			{sessions.map((session) => (
				<SessionRow
					key={session.id}
					me={me}
					session={session}
					isOwner={isOwner}
					act={act}
				/>
			))}
		</div>
	);
}

/** One group: its members, and its projects with their sessions. */
function GroupPanel({
	me,
	group,
	projects,
	sessions,
	friends,
	act,
	reload,
}: {
	me: Me;
	group: Group;
	projects: Project[];
	sessions: Session[];
	friends: Friend[];
	act: (action: () => Promise<unknown>) => () => Promise<void>;
	reload: () => Promise<void>;
}) {
	const isOwner = group.owner === me.name;
	const addable = friends.filter(
		(friend) =>
			friend.state === "friends" && !group.members.includes(friend.name),
	);
	return (
		<Panel
			title={group.own ? `${group.name}, your own group` : group.name}
			description={
				group.own
					? "Only you are in it."
					: `${group.owner}'s group, with everyone in it alike.`
			}
			action={
				<AddByName
					placeholder="project name"
					label="New project"
					onAdd={async (name) => {
						await api.createProject(group.id, name);
						await reload();
					}}
				/>
			}
		>
			{!group.own && (
				<Row
					actions={
						<>
							{isOwner && addable.length > 0 && (
								<select
									aria-label="Add a friend"
									className="h-7 rounded-md border bg-background px-2 font-mono text-xs text-muted-foreground"
									value=""
									onChange={(event) => {
										const name = event.target.value;
										if (name) act(() => api.addMember(group.id, name))();
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
							<Button
								variant="ghost"
								size="sm"
								onClick={act(() =>
									isOwner
										? api.deleteGroup(group.id)
										: api.removeMember(group.id, me.name),
								)}
							>
								{isOwner ? "Delete group" : "Leave"}
							</Button>
						</>
					}
				>
					<Badge variant="secondary" className="font-mono">
						{group.owner}
					</Badge>
					{group.members.map((member) => (
						<Badge key={member} variant="secondary" className="font-mono">
							{member}
							{isOwner && (
								<button
									type="button"
									aria-label={`Remove ${member}`}
									className="ml-1 text-muted-foreground hover:text-foreground"
									onClick={act(() => api.removeMember(group.id, member))}
								>
									×
								</button>
							)}
						</Badge>
					))}
					{group.members.length === 0 && (
						<span className="text-sm text-muted-foreground">
							no one else yet
						</span>
					)}
				</Row>
			)}
			{projects.length === 0 && <Empty>No project yet.</Empty>}
			{projects.map((project) => (
				<ProjectRows
					key={project.id}
					me={me}
					project={project}
					sessions={sessions.filter(
						(session) => session.project.id === project.id,
					)}
					isOwner={isOwner}
					act={act}
					reload={reload}
				/>
			))}
		</Panel>
	);
}

/** The person's groups, each with its projects and their sessions; an app's project shows under the app. */
export function Groups({
	me,
	groups,
	projects,
	sessions,
	friends,
	act,
	reload,
}: {
	me: Me;
	groups: Group[];
	projects: Project[];
	sessions: Session[];
	friends: Friend[];
	act: (action: () => Promise<unknown>) => () => Promise<void>;
	reload: () => Promise<void>;
}) {
	return (
		<section className="flex flex-col gap-10">
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<div className="flex flex-col gap-1">
					<h2 className="font-mono text-lg font-medium tracking-tight">
						Groups
					</h2>
					<p className="max-w-xl text-sm text-pretty text-muted-foreground">
						A group is people, and has projects, each with its sessions. A
						session is open to its group only, or to anyone with its address.
					</p>
				</div>
				<AddByName
					placeholder="group name"
					label="New group"
					onAdd={async (name) => {
						await api.createGroup(name);
						await reload();
					}}
				/>
			</div>
			{groups.map((group) => (
				<GroupPanel
					key={group.id}
					me={me}
					group={group}
					projects={projects.filter(
						(project) => project.group.id === group.id && !project.app,
					)}
					sessions={sessions}
					friends={friends}
					act={act}
					reload={reload}
				/>
			))}
		</section>
	);
}
