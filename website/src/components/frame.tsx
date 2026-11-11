import type { ReactNode } from "react";

/** The look the pages of signing in and onboarding share: a title and a
 * description above the page's content, inside the site's header and footer. */
export function Frame({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<div className="flex justify-center px-6 pt-12 md:pt-20">
			<div className="relative flex w-full max-w-xl flex-col gap-10">
				<header className="flex flex-col gap-4">
					<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
						{title}
					</h1>
					<p className="text-lg text-pretty text-muted-foreground">
						{description}
					</p>
				</header>
				{children}
			</div>
		</div>
	);
}
