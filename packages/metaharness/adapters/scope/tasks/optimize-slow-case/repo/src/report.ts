import { aggregate } from "./aggregate";
import { makeCustomers, makeOrders } from "./data";
import { dedupe } from "./dedupe";
import { format } from "./format";

/** Monthly revenue per region over the first `rows` lines of the export. */
export function buildReport(rows: number, seed = 7): string {
	const customers = makeCustomers(seed);
	const orders = dedupe(makeOrders(rows, customers, seed));
	return format(aggregate(orders, customers), orders.length);
}
