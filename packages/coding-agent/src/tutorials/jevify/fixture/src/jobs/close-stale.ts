import { orders, users } from "../db";
import { log } from "../log";

export function closeStale(): number {
	let closed = 0;
	for (const order of orders.values()) {
		if (order.status === "open" && !users.has(order.userId)) {
			order.status = "cancelled";
			closed++;
		}
	}
	log.info("orphaned orders closed", { closed });
	return closed;
}
