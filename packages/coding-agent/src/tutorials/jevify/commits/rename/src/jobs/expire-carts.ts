import { carts, users } from "../db";
import { logger } from "../log";

export function expireCarts(): number {
	let expired = 0;
	for (const userId of carts.keys()) {
		if (!users.get(userId)?.active) {
			carts.delete(userId);
			expired++;
		}
	}
	logger.info("carts expired", { expired });
	return expired;
}
