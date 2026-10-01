import { users } from "../db";
import { logger } from "../log";

export function dedupeUsers(): number {
	const seen = new Set<string>();
	let removed = 0;
	for (const user of [...users.values()]) {
		if (seen.has(user.email)) {
			users.delete(user.id);
			removed++;
		} else {
			seen.add(user.email);
		}
	}
	logger.info("duplicate users removed", { removed });
	return removed;
}
