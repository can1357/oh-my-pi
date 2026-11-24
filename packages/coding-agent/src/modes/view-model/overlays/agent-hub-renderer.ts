/** Legacy progress snapshots may omit counters; snapshot absence remains distinct. */
function metricNumber(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatCost(cost: number): string {
	const amount = metricNumber(cost);
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	if (amount < 1) return `$${amount.toFixed(3)}`;
	return `$${amount.toFixed(2)}`;
}
