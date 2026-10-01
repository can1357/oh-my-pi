import { orders, type Order } from "../db";
import { log } from "../log";

export function createOrder(id: string, userId: string, total: number): Order {
	if (total <= 0) {
		log.warn("createOrder: non-positive total", { id, total });
		throw new Error("total must be positive");
	}
	const order: Order = { id, userId, total, status: "open" };
	orders.set(id, order);
	log.info("order created", { id, userId });
	return order;
}
