import { orders, type Order } from "../db";
import { logger } from "../log";

export const hot = new Map<string, Order>();

export function warmCache(ids: string[]): number {
	for (const id of ids) {
		const order = orders.get(id);
		if (order) hot.set(id, order);
		else logger.debug("warmCache: missing order", { id });
	}
	logger.info("cache warmed", { size: hot.size });
	return hot.size;
}
