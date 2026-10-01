import { orders } from "../db";
import { log } from "../log";

const COUPONS: Record<string, number> = { WELCOME10: 0.1, SPRING20: 0.2 };

export function applyCoupon(orderId: string, code: string): number | undefined {
	const order = orders.get(orderId);
	const rate = COUPONS[code.toUpperCase()];
	if (!order || rate === undefined) {
		log.warn("applyCoupon: rejected", { orderId, code });
		return undefined;
	}
	order.total = Math.round(order.total * (1 - rate) * 100) / 100;
	log.info("coupon applied", { orderId, code });
	return order.total;
}
