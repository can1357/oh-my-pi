import { orders, type Order } from "../db";
import { log } from "../log";

export const archive: Order[] = [];

export function archiveOrders(): number {
	let moved = 0;
	for (const order of orders.values()) {
		if (order.status === "cancelled" || order.status === "refunded") {
			archive.push(order);
			orders.delete(order.id);
			moved++;
		}
	}
	log.info("orders archived", { moved });
	return moved;
}
