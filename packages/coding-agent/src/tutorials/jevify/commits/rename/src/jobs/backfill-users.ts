import { users } from "../db";
import { logger } from "../log";

export function backfillUsers(): number {
	let fixed = 0;
	for (const user of users.values()) {
		const normalized = user.email.trim().toLowerCase();
		if (normalized !== user.email) {
			user.email = normalized;
			fixed++;
		}
	}
	logger.info("emails normalized", { fixed });
	return fixed;
}
