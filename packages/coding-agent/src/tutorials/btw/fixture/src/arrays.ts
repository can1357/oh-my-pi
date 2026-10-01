// textkit: array helpers.

export function chunk<T>(items: T[], size: number): T[][] {
	if (size < 1) throw new RangeError(`chunk size must be at least 1, got ${size}`);
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

export function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
	const groups = {} as Record<K, T[]>;
	for (const item of items) {
		const group = key(item);
		(groups[group] ??= []).push(item);
	}
	return groups;
}

export function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
	const pass: T[] = [];
	const fail: T[] = [];
	for (const item of items) (test(item) ? pass : fail).push(item);
	return [pass, fail];
}
