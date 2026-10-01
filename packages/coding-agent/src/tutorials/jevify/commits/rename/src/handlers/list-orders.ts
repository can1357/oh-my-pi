import { orders, type Order } from "../db";
import { logger } from "../log";

export function listOrders(userId: string, status?: Order["status"]): Order[] {
	const result = [...orders.values()].filter(o => o.userId === userId && (!status || o.status === status));
	logger.debug("listOrders", { userId, status, count: result.length });
	return result;
}
