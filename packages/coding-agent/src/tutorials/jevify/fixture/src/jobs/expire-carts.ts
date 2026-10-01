import { carts, users } from "../db";
import { log } from "../log";

export function expireCarts(): number {
	let expired = 0;
	for (const userId of carts.keys()) {
		if (!users.get(userId)?.active) {
			carts.delete(userId);
			expired++;
		}
	}
	log.info("carts expired", { expired });
	return expired;
}
