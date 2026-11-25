import type { Revenue } from "./aggregate";

function money(cents: number): string {
	return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The report text: one line per region and month in sorted order, then the totals. */
export function format(revenue: Revenue, orderCount: number): string {
	const lines = ["region  month    revenue"];
	let total = 0;
	for (const region of [...revenue.keys()].sort()) {
		const months = revenue.get(region) ?? new Map<string, number>();
		for (const month of [...months.keys()].sort()) {
			const cents = months.get(month) ?? 0;
			total += cents;
			lines.push(`${region.padEnd(6)}  ${month}  ${money(cents).padStart(14)}`);
		}
	}
	lines.push(`orders: ${orderCount}  total: ${money(total)}`);
	return lines.join("\n");
}
