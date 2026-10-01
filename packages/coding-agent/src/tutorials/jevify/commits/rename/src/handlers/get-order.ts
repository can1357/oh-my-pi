import { orders, type Order } from "../db";
import { logger } from "../log";

export function getOrder(id: string): Order | undefined {
	const order = orders.get(id);
	if (!order) logger.debug("order not found", { id });
	return order;
}
