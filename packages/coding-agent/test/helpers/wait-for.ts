/** Poll `predicate` on real timers until it holds; throw `message` once `timeoutMs` passes without it. */
export async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(5);
	}
}
