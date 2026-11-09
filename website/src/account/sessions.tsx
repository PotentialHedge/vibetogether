import { AppWindow } from "lucide-react";
/** The account's sessions: the ones the person owns or is a member of, and
 * making new ones. */

import { useState } from "react";
import {
	api,
	type Friend,
	type Me,
	type Open,
	type Session,
} from "@/account/api";
import { AddByName, Empty, Panel, Row } from "@/account/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { page } from "@/site";

/** Copies the prompt that brings an agent into one of the account's sessions,
 * by its id: the agent finds its link through the account itself, so no
 * secret passes through the person's paste. */
function CopySessionPrompt({ session }: { session: Session }) {
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

/** Whom a session is open to, as its owner sets it. */
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

export function Sessions({
	me,
	sessions,
	friends,
	act,
	reload,
}: {
	me: Me;
	sessions: Session[];
	friends: Friend[];
	act: (action: () => Promise<unknown>) => () => Promise<void>;
	reload: () => Promise<void>;
}) {
	const mates = friends.filter((friend) => friend.state === "friends");
	return (
		<Panel
			title="Sessions"
			description="A session lasts until you delete it. It is open to its members only, or to anyone with its address."
			action={
				<AddByName
					placeholder="session name"
					label="New session"
					onAdd={async (name) => {
						await api.createSession(name);
						await reload();
					}}
				/>
			}
		>
			{sessions.length === 0 && <Empty>No session yet.</Empty>}
			{sessions.map((session) => {
				const own = session.owner === me.name;
				const addable = mates.filter(
					(friend) => !session.members.includes(friend.name),
				);
				return (
					<Row key={session.id}>
						<span className="flex items-center gap-2 font-mono">
							{session.app && (
								<AppWindow
									aria-label={session.app}
									className="size-4 text-muted-foreground"
								>
									<title>{session.app}</title>
								</AppWindow>
							)}
							{session.name}
						</span>
						{!own && (
							<span className="text-sm text-muted-foreground">
								by {session.owner}
							</span>
						)}
						<span className="flex flex-wrap items-center gap-1.5">
							{session.members.map((member) => (
								<Badge key={member} variant="secondary" className="font-mono">
									{member}
									{own && (
										<button
											type="button"
											aria-label={`Remove ${member}`}
											className="ml-1 text-muted-foreground hover:text-foreground"
											onClick={act(() => api.removeMember(session.id, member))}
										>
											×
										</button>
									)}
								</Badge>
							))}
							{own && session.members.length === 0 && (
								<span className="text-sm text-muted-foreground">
									no one else yet
								</span>
							)}
						</span>
						<span className="ml-auto flex items-center gap-2">
							{own ? (
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
							{own && addable.length > 0 && (
								<select
									aria-label="Add a friend"
									className="h-7 rounded-md border bg-background px-2 font-mono text-xs text-muted-foreground"
									value=""
									onChange={(event) => {
										const name = event.target.value;
										if (name) act(() => api.addMember(session.id, name))();
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
								<Button
									variant="ghost"
									size="sm"
									onClick={act(() => api.deleteSession(session.id))}
								>
									Delete
								</Button>
							) : (
								<Button
									variant="ghost"
									size="sm"
									onClick={act(() => api.removeMember(session.id, me.name))}
								>
									Leave
								</Button>
							)}
						</span>
					</Row>
				);
			})}
		</Panel>
	);
}
