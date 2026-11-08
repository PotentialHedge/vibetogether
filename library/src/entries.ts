/** What the library lists: every repository with the topic, found on GitHub. */

/** The GitHub topic that puts a repository in the library. */
export const TOPIC = "built-on-vibe-together";

/** The owner whose repositories are the official entries. */
export const OFFICIAL = "luiswirth";

export type Entry = {
	/** `owner/repository`. */
	name: string;
	url: string;
	homepage: string | null;
	description: string | null;
	stars: number;
	official: boolean;
};

/** Asks GitHub's search from the browser, which allows it from any origin.
 * Anonymous search allows each visitor a few requests a minute, which one
 * load of the page stays well within. */
export async function entries(): Promise<Entry[]> {
	const url = `https://api.github.com/search/repositories?q=topic:${TOPIC}+fork:true&sort=stars&order=desc&per_page=100`;
	const response = await fetch(url, {
		headers: { Accept: "application/vnd.github+json" },
	});
	if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
	const found = (await response.json()) as {
		items: {
			full_name: string;
			html_url: string;
			homepage: string | null;
			description: string | null;
			stargazers_count: number;
			owner: { login: string };
		}[];
	};
	return found.items.map((item) => ({
		name: item.full_name,
		url: item.html_url,
		homepage: item.homepage || null,
		description: item.description,
		stars: item.stargazers_count,
		official: item.owner.login === OFFICIAL,
	}));
}
