/** The look every page of a person's onboarding shares. Styled with Tailwind
 * and shadcn's theme variables, so it takes on each client's theme; the
 * client adds this directory to Tailwind's sources, as
 * `@source "../node_modules/ui/onboard"`. */

import type { ReactNode } from "react";

/** A page's title and description above its content, inside a site's own
 * header and footer, which name the service. */
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
