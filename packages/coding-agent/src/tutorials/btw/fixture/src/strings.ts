// textkit: string helpers.

export function slugify(input: string): string {
	return input
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function truncate(input: string, max: number, ellipsis = "..."): string {
	if (input.length <= max) return input;
	return input.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

export function titleCase(input: string): string {
	return input.replace(/\b\w/g, letter => letter.toUpperCase());
}

export function countWords(input: string): number {
	const words = input.trim().split(/\s+/);
	return words[0] === "" ? 0 : words.length;
}
