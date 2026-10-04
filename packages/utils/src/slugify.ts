/** Lowercase ASCII kebab slug: [^a-z0-9]+ → "-", edge dashes trimmed; optional maxLength truncates then re-trims trailing dashes. Returns "" when nothing survives. */
export function slugify(input: string, options?: { maxLength?: number }): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return options?.maxLength === undefined ? slug : slug.slice(0, options.maxLength).replace(/-+$/g, "");
}
