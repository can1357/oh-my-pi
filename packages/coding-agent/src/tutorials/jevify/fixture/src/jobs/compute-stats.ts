import { orders } from "../db";
import { log } from "../log";

export function computeStats(): { paid: number; revenue: number } {
	let paid = 0;
	let revenue = 0;
	for (const order of orders.values()) {
		if (order.status !== "paid") continue;
		paid++;
		revenue += order.total;
	}
	log.info("stats computed", { paid, revenue });
	return { paid, revenue };
}
