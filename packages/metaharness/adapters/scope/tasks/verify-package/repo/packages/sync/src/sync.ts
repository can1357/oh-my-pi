/**
 * Polls `fetchList` every `intervalMs` until it returns the same list twice in a row, then
 * resolves with that list.
 */
export async function mirror(fetchList: () => Promise<string[]>, intervalMs = 500): Promise<string[]> {
	let previous = await fetchList();
	for (;;) {
		await Bun.sleep(intervalMs);
		const current = await fetchList();
		if (current.length === previous.length && current.every((item, index) => item === previous[index])) return current;
		previous = current;
	}
}
