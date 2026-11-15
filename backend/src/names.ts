/** One part of a name: `a` to `z`, digits and hyphens, starting with a letter or digit. */
export function isNamePart(part: string): boolean {
	return part.length <= 256 && /^[a-z0-9][a-z0-9-]*$/.test(part);
}
