/** The app: the person's DMs and groups in the rail, the open group's projects
 * and sessions in the sidebar, and the open session or DM, live: a DM has no
 * sidebar, since it is no group's. On a phone, the
 * navigation and the session take the screen in turn. */

import { ArrowLeft, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Frame } from "ui/onboard";
import {
	api,
	type Dm,
	demo,
	type Friend,
	type Group,
	type Me,
	type Project,
	type Session,
	Unauthorized,
} from "@/account/api";
import { useActions } from "@/account/parts";
import {
	ConfirmDialog,
	CopySessionPrompt,
	type DmOfFriend,
	Rail,
	Sidebar,
} from "@/account/sessions";
import { SignIn } from "@/account/sign-in";
import { Transcript } from "@/account/transcript";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { render, Site } from "@/site";

type State = {
	me: Me;
	groups: Group[];
	projects: Project[];
	sessions: Session[];
	friends: Friend[];
	dms: Dm[];
};

async function load(): Promise<State> {
	const [me, groups, projects, sessions, friends, dms] = await Promise.all([
		api.me(),
		api.groups(),
		api.projects(),
		api.sessions(),
		api.friends(),
		api.dms(),
	]);
	return { me, groups, projects, sessions, friends, dms };
}

/** What is open, kept in the address so that a reload or a link opens it
 * again: a session, a DM by its friend's name, or a group with none of its
 * sessions open. */
type Place = {
	group?: string | undefined;
	session?: string | undefined;
	dm?: string | undefined;
};

function placeOfAddress(): Place {
	const query = new URLSearchParams(location.search);
	return {
		group: query.get("group") ?? undefined,
		session: query.get("session") ?? undefined,
		dm: query.get("dm") ?? undefined,
	};
}

function go(place: Place) {
	const query = new URLSearchParams();
	if (place.session) query.set("session", place.session);
	else if (place.dm) query.set("dm", place.dm);
	else if (place.group) query.set("group", place.group);
	const search = query.size ? `?${query}` : "";
	history.pushState(null, "", `${location.pathname}${search}${location.hash}`);
}

const LAST = "vibetogether last session";

function App({ state, reload }: { state: State; reload: () => Promise<void> }) {
	const { me, groups, projects, sessions, friends, dms } = state;
	const { problem, act, dismiss } = useActions(reload);
	const [deletingSession, setDeletingSession] = useState(false);
	const [place, setPlace] = useState<Place>(() => {
		const place = placeOfAddress();
		if (place.session || place.dm || place.group) return place;
		const last = localStorage.getItem(LAST);
		if (last?.startsWith("dm:")) return { dm: last.slice(3) };
		return last && sessions.some((session) => session.id === last)
			? { session: last }
			: {};
	});
	// On a phone: whether the navigation is shown, rather than the session.
	const [navigating, setNavigating] = useState(!place.session && !place.dm);
	useEffect(() => {
		const back = () => {
			const place = placeOfAddress();
			setPlace(place);
			setNavigating(!place.session && !place.dm);
		};
		addEventListener("popstate", back);
		return () => removeEventListener("popstate", back);
	}, []);

	// Each friend's DM, with their face, in the order friends are listed.
	const dmsOfFriends: DmOfFriend[] = dms.flatMap((dm) => {
		const friend = friends.find((friend) => friend.name === dm.friend);
		return friend ? [{ dm, friend }] : [];
	});
	const dm = dmsOfFriends.find(({ friend }) => friend.name === place.dm);
	const session = dm
		? undefined
		: sessions.find((session) => session.id === place.session);
	const group = dm
		? undefined
		: (groups.find(
				(group) => group.id === (session?.group.id ?? place.group),
			) ??
			groups.find((group) => group.own) ??
			groups[0]);
	useEffect(() => {
		if (session) localStorage.setItem(LAST, session.id);
	}, [session]);
	useEffect(() => {
		if (dm) localStorage.setItem(LAST, `dm:${dm.friend.name}`);
	}, [dm]);

	const open = (next: Place) => {
		go(next);
		setPlace(next);
		setNavigating(!next.session && !next.dm);
	};

	return (
		<div className="flex h-dvh overflow-hidden">
			<div
				className={cn(
					"flex min-h-0 w-full md:w-auto",
					!navigating && "hidden md:flex",
				)}
			>
				<Rail
					me={me}
					dms={dmsOfFriends}
					groups={groups}
					open={dm?.dm.id ?? group?.id}
					onOpen={(id) => open({ group: id })}
					onDm={(id) =>
						open({
							dm: dmsOfFriends.find(({ dm }) => dm.id === id)?.friend.name,
						})
					}
					reload={reload}
				/>
				{group && (
					<Sidebar
						me={me}
						group={group}
						projects={projects.filter(
							(project) => project.group.id === group.id,
						)}
						sessions={sessions}
						friends={friends}
						current={session?.id}
						onSession={(id) => open({ session: id })}
						act={act}
						reload={reload}
					/>
				)}
			</div>
			<main
				className={cn(
					"min-w-0 flex-1 flex-col",
					navigating ? "hidden md:flex" : "flex",
				)}
			>
				{dm ? (
					<Transcript
						key={dm.dm.id}
						session={{
							name: dm.friend.displayName || dm.friend.name,
							address: dm.dm.address,
						}}
						back={
							<Button
								variant="ghost"
								size="icon-sm"
								className="-ml-1 md:hidden"
								aria-label="Back"
								onClick={() => setNavigating(true)}
							>
								<ArrowLeft />
							</Button>
						}
						actions={<CopySessionPrompt session={dm.dm} />}
					/>
				) : session ? (
					<Transcript
						key={session.id}
						session={session}
						back={
							<Button
								variant="ghost"
								size="icon-sm"
								className="-ml-1 md:hidden"
								aria-label="Back to the sessions"
								onClick={() => setNavigating(true)}
							>
								<ArrowLeft />
							</Button>
						}
						actions={<CopySessionPrompt session={session} />}
						menu={
							<DropdownMenuItem
								variant="destructive"
								onClick={() => setDeletingSession(true)}
							>
								Delete session
							</DropdownMenuItem>
						}
					/>
				) : (
					<p className="m-auto max-w-sm px-6 text-center text-sm text-pretty text-muted-foreground">
						{group && !projects.some((project) => project.group.id === group.id)
							? `Make a project in ${group.name} on the left, then start a session in it.`
							: "Open a session on the left, or start one with the + by a project."}
					</p>
				)}
			</main>
			{session && (
				// Any member of its group deletes a session.
				<ConfirmDialog
					open={deletingSession}
					onOpenChange={setDeletingSession}
					title={`Delete ${session.name}?`}
					description="Its transcript goes with it, for everyone in the group."
					label="Delete session"
					onConfirm={act(async () => {
						await api.deleteSession(session.id);
						open({ group: session.group.id });
					})}
				/>
			)}
			{/* Over everything, so that it shows on a phone whichever side is open. */}
			{problem && (
				<div
					role="alert"
					className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-lg items-start gap-2 rounded-xl border bg-popover py-2 pr-2 pl-4 text-sm text-destructive shadow-lg"
				>
					<p className="min-w-0 flex-1 py-1 break-words">{problem}</p>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Dismiss"
						onClick={dismiss}
					>
						<X />
					</Button>
				</div>
			)}
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
			<Site current="account/">
				<Frame
					title="Your account"
					description="Sign in to see your groups, their projects and sessions, your friends, and your tokens."
				>
					<SignIn back={demo ? "#demo" : location.href} />
					<p className="text-sm text-pretty text-muted-foreground">
						Your GitHub name becomes your name in sessions, and your agents take
						part under it, as <code className="font-mono">yourname/claude</code>
						.
					</p>
				</Frame>
			</Site>
		);
	return <App state={state} reload={reload} />;
}

render(<Account />);
