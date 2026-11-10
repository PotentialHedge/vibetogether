/** The app: the person's groups in the rail, the open group's projects and
 * sessions in the sidebar, and the open session, live. On a phone, the
 * navigation and the session take the screen in turn. */

import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Frame } from "ui/onboard";
import {
	api,
	demo,
	type Friend,
	type Group,
	type Me,
	type Open,
	type Project,
	type Session,
	Unauthorized,
} from "@/account/api";
import { useActions } from "@/account/parts";
import { CopySessionPrompt, Rail, Sidebar } from "@/account/sessions";
import { SignIn } from "@/account/sign-in";
import { Transcript } from "@/account/transcript";
import { Button } from "@/components/ui/button";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { page, render, Site } from "@/site";

type State = {
	me: Me;
	groups: Group[];
	projects: Project[];
	sessions: Session[];
	friends: Friend[];
};

async function load(): Promise<State> {
	const [me, groups, projects, sessions, friends] = await Promise.all([
		api.me(),
		api.groups(),
		api.projects(),
		api.sessions(),
		api.friends(),
	]);
	return { me, groups, projects, sessions, friends };
}

/** What is open, kept in the address so that a reload or a link opens it
 * again: a session, or a group with none of its sessions open. */
type Place = { group?: string | undefined; session?: string | undefined };

function placeOfAddress(): Place {
	const query = new URLSearchParams(location.search);
	return {
		group: query.get("group") ?? undefined,
		session: query.get("session") ?? undefined,
	};
}

function go(place: Place) {
	const query = new URLSearchParams();
	if (place.session) query.set("session", place.session);
	else if (place.group) query.set("group", place.group);
	const search = query.size ? `?${query}` : "";
	history.pushState(null, "", `${location.pathname}${search}${location.hash}`);
}

const LAST = "vibetogether last session";

function App({ state, reload }: { state: State; reload: () => Promise<void> }) {
	const { me, groups, projects, sessions, friends } = state;
	const { problem, act } = useActions(reload);
	const [place, setPlace] = useState<Place>(() => {
		const place = placeOfAddress();
		if (place.session || place.group) return place;
		const last = localStorage.getItem(LAST);
		return last && sessions.some((session) => session.id === last)
			? { session: last }
			: {};
	});
	// On a phone: whether the navigation is shown, rather than the session.
	const [navigating, setNavigating] = useState(!place.session);
	useEffect(() => {
		const back = () => {
			const place = placeOfAddress();
			setPlace(place);
			setNavigating(!place.session);
		};
		addEventListener("popstate", back);
		return () => removeEventListener("popstate", back);
	}, []);

	const session = sessions.find((session) => session.id === place.session);
	const group =
		groups.find((group) => group.id === (session?.group.id ?? place.group)) ??
		groups.find((group) => group.own) ??
		groups[0];
	useEffect(() => {
		if (session) localStorage.setItem(LAST, session.id);
	}, [session]);

	const open = (next: Place) => {
		go(next);
		setPlace(next);
		setNavigating(!next.session);
	};
	const isOwner = session !== undefined && group?.owner === me.name;

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
					groups={groups}
					open={group?.id}
					onOpen={(id) => open({ group: id })}
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
				{problem && (
					<p className="border-b px-6 py-2 text-sm text-destructive">
						{problem}
					</p>
				)}
				{session ? (
					<Transcript
						key={session.id}
						session={session}
						me={me}
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
						actions={!session.app && <CopySessionPrompt session={session} />}
						menu={
							!session.app && (
								<SessionMenu
									session={session}
									isOwner={isOwner}
									mayDelete={isOwner || session.creator === me.name}
									act={act}
									onDeleted={() => open({ group: session.group.id })}
								/>
							)
						}
					/>
				) : (
					<p className="m-auto px-6 text-center text-sm text-muted-foreground">
						Open a session on the left, or start one in a project with +.
					</p>
				)}
			</main>
		</div>
	);
}

/** Whom the session is open to, as its group's owner sets it, and deleting it. */
function SessionMenu({
	session,
	isOwner,
	mayDelete,
	act,
	onDeleted,
}: {
	session: Session;
	isOwner: boolean;
	mayDelete: boolean;
	act: (action: () => Promise<unknown>) => () => Promise<void>;
	onDeleted: () => void;
}) {
	if (!isOwner && !mayDelete) return null;
	return (
		<>
			{isOwner && (
				<DropdownMenuRadioGroup
					value={session.open}
					onValueChange={(open: Open) =>
						act(() => api.changeSession(session.id, { open }))()
					}
				>
					<DropdownMenuLabel>Who may join</DropdownMenuLabel>
					<DropdownMenuRadioItem value="members">
						members only
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="link">
						open by link
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			)}
			{isOwner && mayDelete && <DropdownMenuSeparator />}
			{mayDelete && (
				<DropdownMenuItem
					variant="destructive"
					onClick={act(async () => {
						await api.deleteSession(session.id);
						onDeleted();
					})}
				>
					Delete session
				</DropdownMenuItem>
			)}
		</>
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
					description="Sign in to keep sessions that last, add friends, and see and revoke your tokens."
				>
					<SignIn back={demo ? "#demo" : location.href} />
					<p className="text-sm text-pretty text-muted-foreground">
						Your GitHub name becomes your name in sessions, and your agents take
						part under it, as <code className="font-mono">yourname/claude</code>
						. A session without an account needs none of this:{" "}
						<a
							className="text-foreground underline underline-offset-4"
							href={page()}
						>
							start one
						</a>
						.
					</p>
				</Frame>
			</Site>
		);
	return <App state={state} reload={reload} />;
}

render(<Account />);
