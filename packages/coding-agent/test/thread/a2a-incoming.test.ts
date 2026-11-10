import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IncomingRequests } from "../../src/a2a/incoming-requests";
import type { ThreadService } from "../../src/thread/services";
import { a2aIncomingThreadService } from "../../src/thread/services/a2a-incoming";
import { executorThreadService } from "../../src/thread/services/executor";
import { getThreadServices } from "../../src/thread/services/index";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { IncomingProbe, IncomingProbeGlobals } from "../fixtures/a2a-incoming-worker";

interface WorkerHandle {
	readonly worker: SubagentWorker;
	readonly probe: IncomingProbe;
	/** Resolves after the a2a-incoming service's own exit hook has run for this worker. */
	readonly exited: Promise<void>;
}

const workers: WorkerHandle[] = [];
beforeEach(() => IncomingRequests.resetGlobalForTests());
afterEach(() => {
	for (const { worker } of workers.splice(0)) worker.terminate("test end");
	IncomingRequests.resetGlobalForTests();
});

async function startWorker(): Promise<WorkerHandle> {
	const probe = Promise.withResolvers<IncomingProbe>();
	const exited = Promise.withResolvers<void>();
	const probeService: ThreadService = {
		name: "a2a-incoming-probe",
		globals: (): IncomingProbeGlobals => ({
			ready: received => probe.resolve(received),
		}),
	};
	// Registered after the incoming service, so this exit hook runs after the
	// incoming service's own exit cleanup for the same worker.
	const exitTail: ThreadService = {
		name: "a2a-incoming-exit-tail",
		globals: (): Record<string, never> => ({}),
		onWorkerExit: () => exited.resolve(),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/a2a-incoming-worker.ts", import.meta.url),
		services: [a2aIncomingThreadService, probeService, exitTail],
		initTimeoutMs: 60_000,
	});
	const handle: WorkerHandle = {
		worker,
		probe: await probe.promise,
		exited: exited.promise,
	};
	workers.push(handle);
	await worker.ready;
	return handle;
}

describe("incoming A2A registry across workers", () => {
	it("installs the registry before the executor", () => {
		const incoming = getThreadServices().indexOf(a2aIncomingThreadService);
		expect(incoming).toBeGreaterThanOrEqual(0);
		expect(getThreadServices().indexOf(executorThreadService)).toBeGreaterThan(incoming);
	});

	it("shares notes and atomic consumes between main and real workers", async () => {
		const first = await startWorker();
		const second = await startWorker();
		const main = IncomingRequests.global();
		const fromMain = {
			to: "worker-agent",
			from: "peer",
			messageId: "main-note",
			at: 1,
		};
		const fromWorker = {
			to: "main-agent",
			from: "peer",
			messageId: "worker-note",
			at: 2,
		};
		await main.note(fromMain);
		await first.probe.note(fromWorker);
		expect(await second.probe.list()).toEqual([fromMain, fromWorker]);
		expect(
			(
				await first.probe.consume({
					to: "worker-agent",
					messageId: "main-note",
				})
			)?.request,
		).toEqual(fromMain);
		expect((await main.consume({ to: "main-agent" }))?.request).toEqual(fromWorker);
		expect(await second.probe.list()).toEqual([]);
	});

	it("preserves an optional fromUrl across the worker link, note through lease return", async () => {
		const worker = await startWorker();
		const main = IncomingRequests.global();
		const request = {
			to: "worker-agent",
			from: "peer",
			messageId: "url-note",
			at: 1,
			fromUrl: "http://127.0.0.1:7602/",
		};
		await main.note(request);
		// The worker sees the full record over the link...
		expect(await worker.probe.list("worker-agent")).toEqual([request]);
		// ...and a lease claimed on main returns that same request, fromUrl included.
		const lease = await main.consume({ to: "worker-agent", messageId: "url-note" });
		expect(lease?.request).toEqual(request);
		// A release preserves the record for the next claimant, still with fromUrl.
		await main.release(lease!.leaseId);
		const reclaimed = await worker.probe.consume({ to: "worker-agent", messageId: "url-note" });
		expect(reclaimed?.request.fromUrl).toBe("http://127.0.0.1:7602/");
	});

	it("allows only one worker or main to consume the same request", async () => {
		const worker = await startWorker();
		const main = IncomingRequests.global();
		const request = { to: "agent", from: "peer", messageId: "race", at: 1 };
		await main.note(request);
		const results = await Promise.all([worker.probe.consume({ to: "agent" }), main.consume({ to: "agent" })]);
		const leases = results.filter(result => result !== undefined);
		expect(leases).toHaveLength(1);
		expect(leases[0]?.request).toEqual(request);
	});

	it("worker exit reopens only its unconfirmed incoming leases", async () => {
		const first = await startWorker();
		const second = await startWorker();
		const main = IncomingRequests.global();
		const a = { to: "agent", from: "peer", messageId: "a", at: 1 };
		const b = { to: "agent", from: "peer", messageId: "b", at: 2 };
		const c = { to: "agent", from: "peer", messageId: "c", at: 3 };
		await main.note(a);
		await main.note(b);
		await main.note(c);
		const aLease = await first.probe.consume({ to: "agent", messageId: "a" });
		expect(aLease?.request.messageId).toBe("a");
		const bLease = await second.probe.consume({ to: "agent", messageId: "b" });
		expect(bLease?.request.messageId).toBe("b");
		const cLease = await second.probe.consume({ to: "agent", messageId: "c" });
		expect(cLease?.request.messageId).toBe("c");
		expect(await second.probe.confirm(cLease!.leaseId)).toBe(true);

		first.worker.terminate("killed before its reply was acknowledged");
		await first.exited;

		// Only worker 1's lease reopened, at its original FIFO position; the
		// confirmed request is gone, and worker 2's claim stays exclusive.
		expect(await main.list("agent")).toEqual([a]);
		expect(await second.probe.consume({ to: "agent", messageId: "c" })).toBeUndefined();
		expect(await main.consume({ to: "agent", messageId: "b" })).toBeUndefined();

		// The dead worker's stale token cannot settle the reopened request.
		expect(await second.probe.confirm(aLease!.leaseId)).toBe(false);
		expect(await second.probe.release(aLease!.leaseId)).toBe(false);

		// A new claimant gets a fresh lease.
		const reclaimed = await main.consume({ to: "agent", messageId: "a" });
		expect(reclaimed?.request.messageId).toBe("a");
		expect(reclaimed?.leaseId).not.toBe(aLease!.leaseId);
		expect(await main.confirm(reclaimed!.leaseId)).toBe(true);
		expect(await main.list("agent")).toEqual([]);
	});

	it("confirmed lease never reopens", async () => {
		const worker = await startWorker();
		const main = IncomingRequests.global();
		await main.note({ to: "agent", from: "peer", messageId: "one", at: 1 });
		const lease = await worker.probe.consume({ to: "agent" });
		expect(await worker.probe.confirm(lease!.leaseId)).toBe(true);
		worker.worker.terminate("killed after acknowledgement");
		await worker.exited;
		expect(await main.list("agent")).toEqual([]);
		expect(await main.consume({ to: "agent" })).toBeUndefined();
	});

	it("prevents another worker confirming or releasing a foreign lease", async () => {
		const first = await startWorker();
		const second = await startWorker();
		const main = IncomingRequests.global();
		const a = { to: "agent", from: "peer", messageId: "a", at: 1 };
		const b = { to: "agent", from: "peer", messageId: "b", at: 2 };
		await main.note(a);
		await main.note(b);
		const aLease = await first.probe.consume({ to: "agent", messageId: "a" });
		const bLease = await second.probe.consume({ to: "agent", messageId: "b" });

		// Neither worker can settle the other's lease.
		expect(await first.probe.confirm(bLease!.leaseId)).toBe(false);
		expect(await first.probe.release(bLease!.leaseId)).toBe(false);
		expect(await second.probe.confirm(aLease!.leaseId)).toBe(false);
		expect(await second.probe.release(aLease!.leaseId)).toBe(false);
		// Each owner settles its own claim.
		expect(await first.probe.confirm(aLease!.leaseId)).toBe(true);
		expect(await second.probe.release(bLease!.leaseId)).toBe(true);
		expect(await main.list("agent")).toEqual([b]);
	});

	it("rejects new claims from a dead worker's link", async () => {
		const first = await startWorker();
		const main = IncomingRequests.global();
		await main.note({ to: "agent", from: "peer", messageId: "a", at: 1 });
		first.worker.terminate("test exit");
		await first.exited;
		// The dead worker's proxy cannot make new claims or settlements.
		await expect(first.probe.consume({ to: "agent" })).rejects.toThrow();
		await expect(first.probe.confirm("any-lease")).rejects.toThrow();
		await expect(first.probe.release("any-lease")).rejects.toThrow();
	});

	it("explicit and automatic reply race has one claimant", async () => {
		const worker = await startWorker();
		const main = IncomingRequests.global();
		await main.note({ to: "agent", from: "peer", messageId: "raced", at: 1 });
		const results = await Promise.all([
			worker.probe.consume({ to: "agent", messageId: "raced" }),
			main.consume({ to: "agent", messageId: "raced" }),
		]);
		const leases = results.filter(result => result !== undefined);
		expect(leases).toHaveLength(1);
		expect(leases[0]!.request.messageId).toBe("raced");
	});

	it("a worker discard removes open and leased records on main", async () => {
		const first = await startWorker();
		const second = await startWorker();
		const main = IncomingRequests.global();
		const a = { to: "agent", from: "peer", messageId: "a", at: 1 };
		const b = { to: "agent", from: "peer", messageId: "b", at: 2 };
		const foreign = { to: "agent", from: "other", messageId: "foreign", at: 3 };
		await main.note(a);
		await main.note(b);
		await main.note(foreign);
		const bLease = await first.probe.consume({ to: "agent", messageId: "b" });
		expect(bLease?.request.messageId).toBe("b");

		await second.probe.discard({ to: "agent", from: "peer", messageId: "b" });

		// The leased record is gone, its token is spent, and the rest survive.
		expect(await main.list("agent")).toEqual([a, foreign]);
		expect(await first.probe.release(bLease!.leaseId)).toBe(false);
		expect(await first.probe.confirm(bLease!.leaseId)).toBe(false);
		expect(await main.list("agent")).toEqual([a, foreign]);
		await first.probe.discard({ to: "agent", from: "peer", messageId: "a" });
		expect(await main.list("agent")).toEqual([foreign]);
	});
});
