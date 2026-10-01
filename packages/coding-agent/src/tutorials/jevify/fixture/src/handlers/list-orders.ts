import { orders, type Order } from "../db";
import { log } from "../log";

export function listOrders(userId: string, status?: Order["status"]): Order[] {
	const result = [...orders.values()].filter(o => o.userId === userId && (!status || o.status === status));
	log.debug("listOrders", { userId, status, count: result.length });
	return result;
}
