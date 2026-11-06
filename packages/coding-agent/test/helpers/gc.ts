/** Force GC on real timers until `ref` is collected; resolve false once `timeoutMs` passes without it. */
export async function collected(
	ref: WeakRef<object>,
	timeoutMs: number,
	{ intervalMs = 100 }: { intervalMs?: number } = {},
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		Bun.gc(true);
		if (ref.deref() === undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(intervalMs);
	}
}
