import { useEffect, useState } from "react";
import { Frame } from "vibetogether-web/onboard";
import { api } from "@/account/api";
import { SignIn, useMe } from "@/account/sign-in";
import { page, render, Site } from "@/site";

const service = "vibetogether.agentics.lwirth.com";

function hostOf(url: string | null): string | null {
	if (!url) return null;
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

/** Where an MCP client's request for access is answered, with the query the
 * account service gives it. */
function ConsentPage() {
	const me = useMe();
	const query = new URLSearchParams(location.search);
	const oauthQuery = location.search.slice(1);
	const id = query.get("client_id");
	const redirect = hostOf(query.get("redirect_uri"));
	// A client whose id is the URL of its metadata document (CIMD) is
	// vouched for by that URL's host; any other registered itself, with a
	// name of its own choosing.
	const vouched = id?.startsWith("https://") ? hostOf(id) : null;
	const [client, setClient] = useState(id ?? "An MCP client");
	useEffect(() => {
		if (id) api.clientName(id).then(setClient, () => {});
	}, [id]);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	if (me === null) return null;
	if (me === "signed-out")
		return (
			<Frame
				name={service}
				title="Sign in"
				description="An agent asks for access to your account. Sign in first."
			>
				<SignIn back={page("account/")} oauthQuery={oauthQuery} />
			</Frame>
		);

	const answer = async (accept: boolean) => {
		setBusy(true);
		try {
			location.href = await api.consent(accept, oauthQuery);
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
			setBusy(false);
		}
	};

	return (
		<Frame
			name={service}
			title="Allow access?"
			description="Allow only an agent you are connecting yourself, right now."
		>
			<div className="flex flex-col gap-4 rounded-2xl border bg-card/60 p-5">
				<p className="text-muted-foreground">
					<span className="font-mono text-foreground">{client}</span>
					{vouched ? (
						<>
							{" "}
							(described by <span className="font-mono">{vouched}</span>)
						</>
					) : (
						" (a name it gave itself)"
					)}{" "}
					asks to act for your account,{" "}
					<span className="font-mono text-foreground">{me.name}</span>, as you
					do: in your rooms, with your friends.
				</p>
				<p className="text-muted-foreground">
					Allowing it gives access to your account to whatever runs at{" "}
					<span className="font-mono text-foreground">
						{redirect ?? "an unknown address"}
					</span>
					. Allow only if that is where your agent runs, such as{" "}
					<span className="font-mono">localhost</span> for Claude Code. You can
					revoke it on your account page.
				</p>
				<div className="flex gap-3">
					<button
						type="button"
						disabled={busy || !redirect}
						className="h-11 rounded-xl bg-primary px-6 font-medium text-primary-foreground transition-all hover:bg-primary/85 active:translate-y-px disabled:opacity-50"
						onClick={() => answer(true)}
					>
						Allow
					</button>
					<button
						type="button"
						disabled={busy}
						className="h-11 rounded-xl border px-6 font-medium transition-all hover:bg-muted active:translate-y-px disabled:opacity-50"
						onClick={() => answer(false)}
					>
						Deny
					</button>
				</div>
			</div>
			{problem && <p className="text-sm text-destructive">{problem}</p>}
		</Frame>
	);
}

render(
	<Site current="account/">
		<ConsentPage />
	</Site>,
);
