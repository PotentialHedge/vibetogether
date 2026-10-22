/** What the library lists, shared by the worker and the page. */

/** The GitHub topic that puts a repository in the library. */
export const TOPIC = "byoa-protocol";

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
