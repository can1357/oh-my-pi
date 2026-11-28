// Evaluated before the real entry. Answers a heap-snapshot request posted on the channel (the heap tests
// under test/thread post it): after full collections, this worker writes a V8-format heap snapshot of its
// thread to the request's `path` and posts `{ written: path, threadId }` back. A request that names a
// `threadId` is answered only by that worker. Tests import this module's types only: importing it would
// make the importing thread answer requests too.
import { currentThreadId } from "../../src/thread/identity";
import { collectGarbage } from "../helpers/heap-snapshot";

/** Named in the tests that request a worker's snapshot. */
const SUBAGENT_HEAP_CHANNEL = "omp-test-subagent-heap";

/** What a test posts on {@link SUBAGENT_HEAP_CHANNEL}. */
export interface SubagentHeapRequest {
	readonly path: string;
	readonly threadId?: string;
}

/** What the worker posts back once the snapshot is on disk. */
export interface SubagentHeapWritten {
	readonly written: string;
	readonly threadId: string;
}

function isRequest(value: unknown): value is SubagentHeapRequest {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "path") === "string";
}

const channel = new BroadcastChannel(SUBAGENT_HEAP_CHANNEL);
channel.addEventListener("message", event => {
	const { data } = event as MessageEvent<unknown>;
	if (!isRequest(data)) return;
	const threadId = currentThreadId();
	if (data.threadId !== undefined && data.threadId !== threadId) return;
	void (async () => {
		await collectGarbage();
		await Bun.write(data.path, Bun.generateHeapSnapshot("v8"));
		const written: SubagentHeapWritten = { written: data.path, threadId };
		channel.postMessage(written);
	})();
});
