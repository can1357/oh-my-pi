/** Synthetic order export, shaped like production: re-exported lines and mixed-case customer ids. */

export interface Customer {
	id: string;
	region: string;
}

export interface Order {
	id: string;
	customerId: string;
	/** `YYYY-MM`. */
	month: string;
	amountCents: number;
}

const REGIONS = ["AMER", "APAC", "EMEA", "LATAM"];
const CUSTOMER_COUNT = 9000;

/** Seeded PRNG (mulberry32): the same seed always yields the same export. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function makeCustomers(seed: number): Customer[] {
	const next = random(seed);
	return Array.from({ length: CUSTOMER_COUNT }, (_, index) => ({
		id: `CUST-${String(index).padStart(5, "0")}`,
		region: REGIONS[Math.floor(next() * REGIONS.length)],
	}));
}

export function makeOrders(rows: number, customers: readonly Customer[], seed: number): Order[] {
	const next = random(seed + 1);
	const orders: Order[] = [];
	for (let line = 0; line < rows; line++) {
		// About 3% of export lines re-export an earlier order, sometimes with a corrected amount.
		if (orders.length > 0 && next() < 0.03) {
			const earlier = orders[Math.floor(next() * orders.length)];
			orders.push({ ...earlier, amountCents: earlier.amountCents + Math.floor(next() * 3) * 100 });
			continue;
		}
		const customer = customers[Math.floor(next() * customers.length)];
		orders.push({
			id: `ord-${String(line).padStart(7, "0")}`,
			customerId: next() < 0.5 ? customer.id : customer.id.toLowerCase(),
			month: `2025-${String(1 + Math.floor(next() * 12)).padStart(2, "0")}`,
			amountCents: 500 + Math.floor(next() * 250_000),
		});
	}
	return orders;
}
