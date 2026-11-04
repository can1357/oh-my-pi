/**
 * The clock of {@link ../test-lifetime | trackTestLifetime}, in a worker so that it keeps real
 * time whatever the test thread does: Bun's fake timers move every clock a test can read, and a
 * test that blocks its thread stops timers and `Atomics.waitAsync` wakes from arriving at all.
 *
 * It writes milliseconds since its own start into the first cell of the buffer it is sent, and
 * sets the second cell once, to say the first is live.
 */
declare const self: Worker;

self.onmessage = (event: MessageEvent) => {
	const cell = new Int32Array(event.data as SharedArrayBuffer);
	const start = Bun.nanoseconds();
	const tick = setInterval(() => {
		Atomics.store(cell, 0, Math.round((Bun.nanoseconds() - start) / 1e6));
	}, 1);
	tick.unref?.();
	Atomics.store(cell, 1, 1);
	Atomics.notify(cell, 1);
};
