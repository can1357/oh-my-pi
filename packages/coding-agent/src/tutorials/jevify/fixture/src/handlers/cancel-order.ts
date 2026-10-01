import { orders } from "../db";
import { log } from "../log";

export function cancelOrder(id: string): boolean {
	const order = orders.get(id);
	if (!order || order.status !== "open") {
		log.warn("cancelOrder: not cancellable", { id, status: order?.status });
		return false;
	}
	order.status = "cancelled";
	log.info("order cancelled", { id });
	return true;
}
