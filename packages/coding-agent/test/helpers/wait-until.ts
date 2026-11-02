/** Poll `condition` on real timers until it holds; throw once `timeoutMs` passes without it. */
export async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not reached before timeout");
		await Bun.sleep(5);
	}
}
