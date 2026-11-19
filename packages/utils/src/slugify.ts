/** Lowercase ASCII kebab slug: [^a-z0-9]+ → "-", edge dashes trimmed; optional maxLength truncates then re-trims trailing dashes; throws RangeError unless maxLength is a non-negative integer. Returns "" when nothing survives. */
export function slugify(input: string, options?: { maxLength?: number }): string {
	if (options?.maxLength !== undefined && !(Number.isInteger(options.maxLength) && options.maxLength >= 0)) {
		throw new RangeError(`slugify maxLength must be a non-negative integer, got ${options.maxLength}`);
	}
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return options?.maxLength === undefined ? slug : slug.slice(0, options.maxLength).replace(/-+$/g, "");
}
