import { db, transaction } from "./db.ts";

/** The most repositories one project points at. */
export const maxRepos = 20;

const github = "https://github.com/";

/**
 * A GitHub repository as `owner/name`, from that or its URL, with or without `.git`,
 * or undefined where it is none: GitHub's owners are letters, digits and inner hyphens,
 * its repository names letters, digits, `.`, `_` and `-`.
 */
export function repoOf(given: string): string | undefined {
	let repo = given.trim();
	if (repo.startsWith(github)) repo = repo.slice(github.length);
	repo = repo.replace(/\/$/, "").replace(/\.git$/, "");
	const [owner, name, ...rest] = repo.split("/");
	if (rest.length || !owner || !name) return undefined;
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner))
		return undefined;
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..")
		return undefined;
	return `${owner}/${name}`;
}

/** The repositories as a request gives them, a list of `owner/name` or URLs, or undefined where malformed. */
export function reposOfInput(given: unknown): string[] | undefined {
	if (!Array.isArray(given) || given.length > maxRepos) return undefined;
	const repos: string[] = [];
	for (const each of given) {
		const repo = typeof each === "string" ? repoOf(each) : undefined;
		if (!repo) return undefined;
		if (!repos.some((r) => r.toLowerCase() === repo.toLowerCase()))
			repos.push(repo);
	}
	return repos;
}

/** The repositories `project` points at, as their URLs. */
export function reposOf(project: string): string[] {
	return (
		db
			.prepare(
				"SELECT repo FROM project_repo WHERE project = ? ORDER BY position",
			)
			.all(project) as { repo: string }[]
	).map(({ repo }) => github + repo);
}

/** Points `project` at `repos`, in place of the ones before. */
export function setRepos(project: string, repos: string[]): void {
	transaction(() => {
		db.prepare("DELETE FROM project_repo WHERE project = ?").run(project);
		const insert = db.prepare(
			"INSERT INTO project_repo (project, position, repo) VALUES (?, ?, ?)",
		);
		for (const [position, repo] of repos.entries())
			insert.run(project, position, repo);
	});
}

export const reposHelp = `"repos" is a list of at most ${maxRepos} GitHub repositories, each as "owner/name" or its URL`;
