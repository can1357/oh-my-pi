import { orders, users } from "../db";
import { logger } from "../log";

export function refund(orderId: string, amount: number): boolean {
	const order = orders.get(orderId);
	if (!order || order.status !== "paid") return false;
	if (amount >= order.total) {
		logger.warn("refund exceeds order total", { orderId, amount });
		return false;
	}
	const user = users.get(order.userId);
	if (user) user.balance += amount;
	order.status = "refunded";
	logger.info("refund issued", { orderId, amount });
	return true;
}
