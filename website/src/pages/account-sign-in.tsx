import { Frame } from "ui/onboard";
import { SignIn } from "@/account/sign-in";
import { page, render, Site } from "@/site";

/** Where an MCP client sends its person to sign in, before it asks for
 * access: the account service goes on with the request once they have. */
function SignInPage() {
	return (
		<Frame
			name="vibetogether.agentics.lwirth.com"
			title="Sign in"
			description="Your agent asks to connect to your account through the MCP server. Sign in, then confirm what it may do."
		>
			<SignIn back={page("account/")} oauthQuery={location.search.slice(1)} />
		</Frame>
	);
}

render(
	<Site current="account/">
		<SignInPage />
	</Site>,
);
