/** URL slug for a post title: lowercase words joined by single dashes. */
export function slugify(title: string): string {
	return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-");
}
