import type { Order } from "./data";

/** Drops re-exported lines: the first line carrying an order id wins. */
export function dedupe(orders: readonly Order[]): Order[] {
	const seen: string[] = [];
	const unique: Order[] = [];
	for (const order of orders) {
		if (seen.includes(order.id)) continue;
		seen.push(order.id);
		unique.push(order);
	}
	return unique;
}
