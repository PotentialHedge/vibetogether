import type { ReactNode } from "react";
import { MoreInfo } from "@/components/more-info";

/** The look the pages of signing in and onboarding share: a title, one short
 * line under it with anything longer behind its info icon, and the page's
 * content, inside the site's header and footer. */
export function Frame({
	title,
	description,
	info,
	children,
}: {
	title: string;
	description?: string;
	/** The longer explanation, behind an info icon. */
	info?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex justify-center px-6 pt-12 md:pt-20">
			<div className="relative flex w-full max-w-xl flex-col gap-8">
				<header className="flex flex-col gap-3">
					<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
						{title}
					</h1>
					{description && (
						<p className="text-lg text-pretty text-muted-foreground">
							{description}
							{info && <MoreInfo>{info}</MoreInfo>}
						</p>
					)}
				</header>
				{children}
			</div>
		</div>
	);
}
