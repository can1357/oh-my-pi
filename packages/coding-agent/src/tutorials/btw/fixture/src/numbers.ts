// textkit: number helpers.

export function clamp(value: number, min: number, max: number): number {
	if (min > max) throw new RangeError(`min ${min} is greater than max ${max}`);
	return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

export function percent(part: number, whole: number): string {
	if (whole === 0) return "0%";
	return `${roundTo((part / whole) * 100, 1)}%`;
}

export function average(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	let sum = 0;
	for (const value of values) sum += value;
	return sum / values.length;
}
