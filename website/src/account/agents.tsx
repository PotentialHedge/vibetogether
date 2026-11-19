/** The person's agents, in the app beside their groups: each with its
 * presence and status, the groups it is in, picked from one button, and
 * renamed or deleted in place, into the trash. Only the person adds an agent
 * to a group. */

import { ArrowLeft, Bot, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type Agent, api, demo, type Group } from "@/account/api";
import { AddByName, Presence, Titled } from "@/account/parts";
import { Picker } from "@/account/picker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { page } from "@/site";

type Act = (action: () => Promise<unknown>) => () => Promise<void>;

const when = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

export function Agents({
	live,
	groups,
	act,
	reload,
	back,
}: {
	/** The agents outside the trash, as the overview has them, which
	 * changes whenever one does. */
	live: Agent[];
	groups: Group[];
	act: Act;
	reload: () => Promise<void>;
	/** The way back to the navigation, on a phone. */
	back: ReactNode;
}) {
	const shared = groups.filter((group) => !group.own);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
				{back}
				<Bot className="size-4 text-muted-foreground" />
				<h1 className="font-mono text-sm font-medium">Agents</h1>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-6">
					<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
						<p className="max-w-md text-sm text-pretty text-muted-foreground">
							Each is in your own group, and in the groups you pick for it:
							their members see and reach it, and it sees and acts in them.
						</p>
						<AddByName
							placeholder="agent name"
							label="Create"
							onAdd={async (name) => {
								await api.createAgent(name);
								await reload();
							}}
						/>
					</div>
					{live.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No agents yet: an agent creates itself when it is set up, or you
							create one here and give it its id.
						</p>
					) : (
						<ul className="divide-y overflow-hidden rounded-xl border bg-card/50">
							{live.map((agent) => (
								<AgentRow
									key={agent.id}
									agent={agent}
									groups={shared}
									act={act}
								/>
							))}
						</ul>
					)}
					<a
						href={page(`account/settings/?tab=trash${demo ? "#demo" : ""}`)}
						className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
					>
						Deleted agents are in the trash, for 30 days.
					</a>
				</div>
			</div>
		</div>
	);
}

/** One agent: its name, id, presence and status, its groups behind one
 * button, renamed in place, and deleted after a second click, into the
 * trash. */
function AgentRow({
	agent,
	groups,
	act,
}: {
	agent: Agent;
	/** The person's groups but their own. */
	groups: Group[];
	act: Act;
}) {
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const reachable = agent.presence === "awake" || agent.presence === "asleep";
	const inGroups = groups.filter((group) =>
		group.agents.some((a) => a.id === agent.id),
	);
	const detail = [
		agent.id,
		reachable
			? agent.presence
			: `last seen ${agent.seen ? when.format(new Date(agent.seen)) : "never"}`,
		agent.listening.length > 0 &&
			`in ${agent.listening.map((s) => s.name).join(", ")}`,
		agent.status,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
			<div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
				<Presence
					presence={agent.presence}
					dnd={agent.dnd}
					className="size-2"
				/>
				<span className="min-w-0">
					<Titled title={agent.name} detail={detail} />
				</span>
			</div>
			<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
				{renaming ? (
					<AddByName
						placeholder={agent.name.split("/")[1] ?? ""}
						label="Rename"
						onAdd={async (name) => {
							await act(() => api.renameAgent(agent.id, name))();
							setRenaming(false);
						}}
					/>
				) : deleting ? (
					<>
						<Button
							variant="destructive"
							size="sm"
							onClick={act(() => api.deleteAgent(agent.id))}
						>
							Delete, into the trash
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setDeleting(false)}
						>
							Cancel
						</Button>
					</>
				) : (
					<>
						<Picker
							align="end"
							title={`The groups ${agent.name} is in, besides your own.`}
							empty="No other group yet: one you make or join shows here."
							choices={groups.map((group) => ({
								id: group.id,
								name: group.name,
								ticked: inGroups.includes(group),
							}))}
							onPick={(choice) =>
								act(() =>
									choice.ticked
										? api.removeMember(choice.id, agent.name)
										: api.addMember(choice.id, agent.name),
								)()
							}
							trigger={
								<Button
									variant="outline"
									size="sm"
									title={inGroups.map((g) => g.name).join(", ")}
								>
									<Users />
									<span
										className={cn(
											inGroups.length === 0 && "text-muted-foreground",
										)}
									>
										{inGroups.length === 0
											? "No groups"
											: inGroups.length === 1
												? inGroups[0]?.name
												: `${inGroups.length} groups`}
									</span>
								</Button>
							}
						/>
						<Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
							Rename
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
							Delete
						</Button>
					</>
				)}
			</div>
		</li>
	);
}

/** The back button of a view, shown only on a phone. */
export function Back({ onClick }: { onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			className="-ml-1 md:hidden"
			aria-label="Back"
			onClick={onClick}
		>
			<ArrowLeft />
		</Button>
	);
}
