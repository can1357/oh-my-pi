import { orders, users } from "../db";
import { log } from "../log";

export function checkout(orderId: string): boolean {
	const order = orders.get(orderId);
	const user = order && users.get(order.userId);
	if (!order || !user || order.status !== "open") return false;
	if (user.balance < order.total) {
		log.warn("checkout: insufficient balance", { orderId });
		return false;
	}
	user.balance -= order.total;
	order.status = "paid";
	log.info("order paid", { orderId, total: order.total });
	return true;
}
