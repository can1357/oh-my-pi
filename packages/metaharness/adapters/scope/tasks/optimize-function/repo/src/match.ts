import { editDistance } from "./distance";

export interface Match {
	name: string;
	distance: number;
}

/**
 * Closest catalogue name to `query`, ignoring case and surrounding whitespace. `null` when no
 * name is within `maxDistance`; ties go to the earlier name.
 */
export function bestMatch(query: string, names: readonly string[], maxDistance = 6): Match | null {
	const wanted = query.trim().toLowerCase();
	let best: Match | null = null;
	for (const name of names) {
		const distance = editDistance(wanted, name.toLowerCase());
		if (distance <= maxDistance && (best === null || distance < best.distance)) best = { name, distance };
	}
	return best;
}
