/** The library: every repository with the topic, found on GitHub, and the
 * page and the build guide as static assets. */

import { type Entry, OFFICIAL, TOPIC } from "../src/entries.ts";

/** GitHub's search allows few anonymous requests, so one answer serves all
 * visitors for a while. */
const FRESH = 600;

async function entries(): Promise<Entry[]> {
	const url = `https://api.github.com/search/repositories?q=topic:${TOPIC}+fork:true&sort=stars&order=desc&per_page=100`;
	const response = await fetch(url, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "byoa-library",
		},
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

export default {
	async fetch(request, env, context): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/entries.json") return env.ASSETS.fetch(request);
		const key = new Request(url.toString());
		const cached = await caches.default.match(key);
		if (cached) return cached;
		let body: string;
		try {
			body = JSON.stringify(await entries(), null, "\t");
		} catch (error) {
			return new Response(`${error}\n`, { status: 502 });
		}
		const response = new Response(body, {
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": `public, max-age=${FRESH}`,
				"Access-Control-Allow-Origin": "*",
			},
		});
		context.waitUntil(caches.default.put(key, response.clone()));
		return response;
	},
} satisfies ExportedHandler<Env>;
