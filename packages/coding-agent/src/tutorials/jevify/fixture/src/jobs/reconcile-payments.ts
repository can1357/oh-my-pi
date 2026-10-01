import { orders } from "../db";
import { log } from "../log";

export function reconcilePayments(ledger: Map<string, number>): string[] {
	const mismatched: string[] = [];
	for (const order of orders.values()) {
		if (order.status !== "paid") continue;
		if (ledger.get(order.id) !== order.total) mismatched.push(order.id);
	}
	if (mismatched.length > 0) log.error("payment mismatches", { count: mismatched.length });
	return mismatched;
}
