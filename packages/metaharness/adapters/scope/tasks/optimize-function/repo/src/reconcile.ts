import { bestMatch } from "./match";

/** Feed name → catalogue name, for every feed name with a match; unmatched names are left out. */
export function reconcile(feed: readonly string[], catalogue: readonly string[]): Map<string, string> {
	const mapping = new Map<string, string>();
	for (const name of feed) {
		const match = bestMatch(name, catalogue);
		if (match) mapping.set(name, match.name);
	}
	return mapping;
}
