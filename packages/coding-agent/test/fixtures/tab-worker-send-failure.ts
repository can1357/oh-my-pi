/**
 * Child program behind `test/tools/browser-tab-worker-gone-send.test.ts`.
 *
 * Pins the boundary of the terminated-worker guard: a send that fails for a
 * reason a dead worker cannot explain must reach the caller, and the tab behind
 * it must keep working. Runs in a child process so the worker thread it spawns
 * cannot outlive the test, exactly like the tab worker in production.
 */
import { wrapBunWorkerForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { WorkerInbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";

const worker = new Worker(new URL("./tab-worker-echo.ts", import.meta.url), { type: "module" });
const handle = wrapBunWorkerForTest(worker);

// The handler is declared in outbound-protocol terms, while the echo fixture answers
// with the payload it was handed; project the message's identity instead of claiming
// a protocol type for it.
const delivered = Promise.withResolvers<string>();
const stopListening = handle.onMessage(message =>
	delivered.resolve(`${message.type}/${"id" in message ? String(message.id) : "none"}`),
);

// An unserializable payload is a caller bug rather than a terminated worker.
const unserializable = { type: "abort", id: "r-unserializable", reason: () => "x" } as unknown as WorkerInbound;
try {
	handle.send(unserializable);
	process.stdout.write("SEND_FAILED:false\n");
} catch {
	process.stdout.write("SEND_FAILED:true\n");
}
// The failed send must not mute the tab for the messages after it.
handle.send({ type: "abort", id: "r-after" });
const raced = await Promise.race([delivered.promise, Bun.sleep(3000).then((): "NO DELIVERY" => "NO DELIVERY")]);
stopListening();
process.stdout.write(`DELIVERED:${raced}\n`);
await handle.terminate();
