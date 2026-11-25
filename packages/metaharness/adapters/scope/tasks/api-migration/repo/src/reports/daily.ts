import type { Order } from "../orders";
import type { Store } from "../store";

/** Revenue in cents per day from open orders, days ascending. */
export function dailyRevenue(store: Store): Promise<Array<[day: string, cents: number]>> {
	return new Promise((resolve, reject) => {
		store.list("order:", (error, entries) => {
			if (error) return reject(error);
			const byDay = new Map<string, number>();
			for (const [, doc] of entries ?? []) {
				const order = doc as Order;
				if (order.status === "open") byDay.set(order.day, (byDay.get(order.day) ?? 0) + order.totalCents);
			}
			resolve([...byDay].sort(([a], [b]) => a.localeCompare(b)));
		});
	});
}
