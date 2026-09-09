import type { SplitCommitGroup } from "./state";

export function computeDependencyOrder(groups: SplitCommitGroup[]): number[] | { error: string } {
	const total = groups.length;
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const inDegree = new Array<number>(total).fill(0);
	const edges = Array.from({ length: total }, () => new Set<number>());

	for (let index = 0; index < total; index += 1) {
		const dependencies = groups[index]?.dependencies ?? [];
		for (const dependency of dependencies) {
			if (dependency < 0 || dependency >= total) {
				return { error: `Invalid dependency index: ${dependency}` };
			}
			if (!edges[dependency]?.has(index)) {
				edges[dependency]?.add(index);
				inDegree[index] += 1;
			}
		}
	}

	const queue: number[] = [];
	for (let index = 0; index < total; index += 1) {
		if (inDegree[index] === 0) queue.push(index);
	}

	const order: number[] = [];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		order.push(current);
		for (const next of edges[current] ?? []) {
			inDegree[next] -= 1;
			if (inDegree[next] === 0) {
				queue.push(next);
			}
		}
	}

	if (order.length !== total) {
		return { error: "Circular dependency detected in split commit plan." };
	}

	return order;
}
