import { parentPort } from "node:worker_threads";

// Evaluated before the real entry, so this listener sees each frame first.
// A `ping(-1)` call is hidden from the entry (its `t` tag removed, so it is
// dropped as a non-RPC message) and the worker then crashes with an uncaught
// error, leaving main's call pending.
parentPort?.on("message", (message: unknown) => {
	if (
		typeof message === "object" &&
		message !== null &&
		Reflect.get(message, "t") === "call" &&
		Reflect.get(message, "m") === "ping" &&
		Reflect.get(message, "a")?.[0] === -1
	) {
		Reflect.deleteProperty(message, "t");
		setTimeout(() => {
			throw new Error("fixture crash");
		}, 0);
	}
});
