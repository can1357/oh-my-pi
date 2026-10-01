import { orders, type Order } from "../db";
import { log } from "../log";

export function getOrder(id: string): Order | undefined {
	const order = orders.get(id);
	if (!order) log.debug("order not found", { id });
	return order;
}
