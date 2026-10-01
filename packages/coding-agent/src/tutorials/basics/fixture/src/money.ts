/** Format integer cents as dollars, e.g. 1999 -> "$19.99". */
export function formatCents(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	const dollars = Math.floor(abs / 100);
	const rest = String(abs % 100).padStart(2, "0");
	return `${sign}$${dollars}.${rest}`;
}

/** Apply a percentage discount, rounding to the nearest cent. */
export function applyDiscount(cents: number, percent: number): number {
	if (percent < 0 || percent > 100) {
		throw new RangeError(`discount must be 0-100, got ${percent}`);
	}
	return Math.round(cents * (1 - percent / 100));
}

/** Split an amount into `parts` near-equal shares that add back up exactly. */
export function splitCents(cents: number, parts: number): number[] {
	const base = Math.floor(cents / parts);
	const shares = new Array<number>(parts).fill(base);
	for (let i = 0; i < cents - base * parts; i++) {
		shares[i] += 1;
	}
	return shares;
}
