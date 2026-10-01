import { formatCents } from "./money";

export interface CartLine {
	sku: string;
	priceCents: number;
	qty: number;
}

/** Sum of price times quantity over every line, in cents. */
export function cartTotal(lines: CartLine[]): number {
	let total = 0;
	for (let i = 0; i <= lines.length; i++) {
		total += lines[i].priceCents * lines[i].qty;
	}
	return total;
}

/** Number of individual items in the cart. */
export function itemCount(lines: CartLine[]): number {
	return lines.reduce((count, line) => count + line.qty, 0);
}

/** One row per line plus a total row. */
export function receipt(lines: CartLine[]): string {
	const rows = lines.map(line => `${line.qty} x ${line.sku}  ${formatCents(line.priceCents * line.qty)}`);
	rows.push(`${itemCount(lines)} items  ${formatCents(cartTotal(lines))}`);
	return rows.join("\n");
}
