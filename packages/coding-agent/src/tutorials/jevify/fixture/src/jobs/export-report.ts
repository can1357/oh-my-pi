import { orders } from "../db";
import { log } from "../log";

export function exportReport(): string {
	const rows = ["id,user,total,status"];
	for (const order of orders.values()) {
		rows.push([order.id, order.userId, order.total.toFixed(2), order.status].join(","));
	}
	log.info("report exported", { rows: rows.length - 1 });
	return rows.join("\n");
}
