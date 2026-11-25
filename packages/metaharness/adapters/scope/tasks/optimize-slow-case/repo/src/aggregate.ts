import { regionOf } from "./customers";
import type { Customer, Order } from "./data";

/** Revenue in cents, keyed region → month. */
export type Revenue = Map<string, Map<string, number>>;

export function aggregate(orders: readonly Order[], customers: readonly Customer[]): Revenue {
	const revenue: Revenue = new Map();
	for (const order of orders) {
		const region = regionOf(customers, order.customerId);
		let months = revenue.get(region);
		if (!months) {
			months = new Map();
			revenue.set(region, months);
		}
		months.set(order.month, (months.get(order.month) ?? 0) + order.amountCents);
	}
	return revenue;
}
