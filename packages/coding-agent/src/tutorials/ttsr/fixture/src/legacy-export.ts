import type { Order } from "./orders";

// Written before src/log.ts existed.
export function exportOrders(orders: Order[]): string {
	const csv = orders.map(o => `${o.id},${o.customer},${o.total}`).join("\n");
	console.log(`exported ${orders.length} orders`);
	return csv;
}
