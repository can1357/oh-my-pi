import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import {
	consumeWorkerInbox,
	installWorkerInbox,
	isWorkerHostSelector,
	WORKER_HOST_SELECTOR_PREFIX,
} from "../src/worker-host";

/**
 * Regression for JS/tab eval workers always stalling until the init timeout.
 *
 * The self-dispatching CLI host imports each worker module dynamically from its
 * argv dispatch, so the worker's own `parentPort.on("message")` attaches after
 * Bun flushes the messages the parent posted before spawn — the synchronously
 * posted `init` handshake was dropped and every run waited out the init timeout
 * before silently falling back to the inline worker. `installWorkerInbox`
 * attaches a `message` listener synchronously in the entry's sync prefix and
 * buffers until the worker module `bind`s the real handler; these tests pin that
 * buffer-replay contract.
 */
describe("worker-host selectors", () => {
	it("recognizes the shared selector namespace without claiming ordinary CLI arguments", () => {
		expect(WORKER_HOST_SELECTOR_PREFIX).toBe("__omp_worker_");
		expect(isWorkerHostSelector("__omp_worker_stats_sync")).toBeTrue();
		expect(isWorkerHostSelector("__omp_worker_computer")).toBeTrue();
		expect(isWorkerHostSelector("--version")).toBeFalse();
		expect(isWorkerHostSelector(undefined)).toBeFalse();
	});
});

describe("worker-host inbox", () => {
	// State is a module-global stash (one worker per process); drain it around
	// each test so nothing leaks into the next.
	beforeEach(() => consumeWorkerInbox());
	afterEach(() => consumeWorkerInbox());

	it("replays messages buffered before bind, then forwards live ones, in order", () => {
		const port = new EventEmitter();
		const inbox = installWorkerInbox(port);

		// Parent's pre-bind delivery (Bun's flush) — handler not attached yet.
		port.emit("message", { type: "init" });
		port.emit("message", { type: "run", runId: "r1" });

		const received: unknown[] = [];
		inbox.bind(msg => received.push(msg));
		// Buffered messages replay synchronously on bind, in arrival order.
		expect(received).toEqual([{ type: "init" }, { type: "run", runId: "r1" }]);

		// Subsequent deliveries reach the bound handler directly (not re-buffered).
		port.emit("message", { type: "run", runId: "r2" });
		expect(received).toEqual([{ type: "init" }, { type: "run", runId: "r1" }, { type: "run", runId: "r2" }]);
	});

	it("delivers nothing twice and re-buffers after unbind", () => {
		const port = new EventEmitter();
		const inbox = installWorkerInbox(port);
		port.emit("message", "early");

		const received: unknown[] = [];
		const unbind = inbox.bind(msg => received.push(msg));
		expect(received).toEqual(["early"]);

		// After unbind the handler must stop receiving; messages re-queue instead
		// of throwing or double-dispatching to the stale handler.
		unbind();
		port.emit("message", "after-unbind");
		expect(received).toEqual(["early"]);

		// A fresh bind drains what arrived while unbound — exactly once.
		const received2: unknown[] = [];
		inbox.bind(msg => received2.push(msg));
		expect(received2).toEqual(["after-unbind"]);
	});

	it("hands the installed inbox to a single consumer, then reports none", () => {
		const port = new EventEmitter();
		const inbox = installWorkerInbox(port);

		expect(consumeWorkerInbox()).toBe(inbox);
		// A second consume (or a worker loaded directly with no host pre-buffering)
		// sees no inbox and falls back to its own synchronous listener.
		expect(consumeWorkerInbox()).toBeNull();
	});
});
