import { SignIn } from "@/account/sign-in";
import { Frame } from "@/components/frame";
import { page, render, Site } from "@/site";

/** Where an MCP client sends its person to sign in, before it asks for
 * access: the account service goes on with the request once they have. */
function SignInPage() {
	return (
		<Frame
			title="Sign in"
			description="Your agent wants to connect. Sign in to allow it."
			info="It asks through the MCP server. Once you sign in, you see what it asks for and allow or deny it."
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
