/** Middle value of `values`; the mean of the two middle values for an even count. */
export function median(values: number[]): number {
	const sorted = values.sort();
	return sorted[Math.floor(sorted.length / 2)];
}
