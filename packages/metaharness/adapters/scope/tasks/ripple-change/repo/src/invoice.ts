import { formatMoney } from "./money";

export interface LineItem {
	name: string;
	cents: number;
}

/** Plain-text invoice: one right-aligned amount per item, then the total. */
export function renderInvoice(items: LineItem[]): string {
	const total = items.reduce((sum, item) => sum + item.cents, 0);
	const lines = items.map(item => `${item.name.padEnd(12)}${formatMoney(item.cents).padStart(10)}`);
	lines.push(`${"Total".padEnd(12)}${formatMoney(total).padStart(10)}`);
	return lines.join("\n");
}

/** One-line summary for notifications. */
export function summarize(items: LineItem[]): string {
	const total = items.reduce((sum, item) => sum + item.cents, 0);
	return `${items.length} items, ${formatMoney(total)}`;
}
