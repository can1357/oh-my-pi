import { orders } from "../db";
import { logger } from "../log";

export function cancelOrder(id: string): boolean {
	const order = orders.get(id);
	if (!order || order.status !== "open") {
		logger.warn("cancelOrder: not cancellable", { id, status: order?.status });
		return false;
	}
	order.status = "cancelled";
	logger.info("order cancelled", { id });
	return true;
}
