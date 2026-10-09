/** Opted-in diagnostic subscriptions must be armed before a fast owned service can exit. */
const barriers = new Map<string, Set<Promise<void>>>();

export function registerServiceObservationBarrier(owner: string, ready: Promise<void>): () => void {
	let pending = barriers.get(owner);
	if (!pending) {
		pending = new Set();
		barriers.set(owner, pending);
	}
	const active = pending;
	active.add(ready);
	const remove = (): void => {
		active.delete(ready);
		if (active.size === 0) barriers.delete(owner);
	};
	void ready.then(remove, remove);
	return remove;
}

export async function awaitServiceObservationBarrier(owner: string | null | undefined): Promise<void> {
	if (!owner) return;
	const pending = barriers.get(owner);
	if (pending) await Promise.all(pending);
}
