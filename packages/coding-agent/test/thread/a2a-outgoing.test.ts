/**
 * Outgoing A2A registry across a real subagent worker link. Same-thread fakes
 * do not cover boot, `callSync` ownership checks, or exit teardown.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sendA2aMessage } from "../../src/a2a/rpc";
import { type OutgoingRequest, OutgoingRequests } from "../../src/a2a/outgoing-requests";
import type { ThreadService } from "../../src/thread/services";
import { a2aOutgoingThreadService } from "../../src/thread/services/a2a-outgoing";
import { THREAD_SERVICES } from "../../src/thread/services/index";
import { executorThreadService } from "../../src/thread/services/executor";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { OutgoingProbe, OutgoingProbeGlobals } from "../fixtures/a2a-outgoing-worker";

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	OutgoingRequests.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	OutgoingRequests.resetGlobalForTests();
});

function request(overrides: Partial<OutgoingRequest> = {}): OutgoingRequest {
	return {
		messageId: "m1",
		peer: "peer-a",
		ownerId: "owner-a",
		jobId: "job-a",
		deadline: null,
		...overrides,
	};
}

function mainRegistry(): OutgoingRequests {
	const registry = OutgoingRequests.global();
	if (!(registry instanceof OutgoingRequests)) throw new Error("expected the main-thread registry");
	return registry;
}

async function startWorker(): Promise<{ worker: SubagentWorker; probe: OutgoingProbe }> {
	const probe = Promise.withResolvers<OutgoingProbe>();
	const probeService: ThreadService = {
		name: "a2a-outgoing-probe",
		globals: (): OutgoingProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/a2a-outgoing-worker.ts", import.meta.url),
		services: [a2aOutgoingThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return { worker, probe: await probe.promise };
}

/**
 * Poll a condition fed by another thread. There is no in-process clock to fake
 * across a real worker; this waits on the condition itself, never a guessed duration.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

describe("outgoing A2A registry across workers", () => {
	it("is installed before the executor so a worker task can register a wait", () => {
		const names = THREAD_SERVICES.map(service => service.name);
		const outgoing = names.indexOf(a2aOutgoingThreadService.name);
		const executor = names.indexOf(executorThreadService.name);
		expect(outgoing).toBeGreaterThanOrEqual(0);
		expect(executor).toBeGreaterThan(outgoing);
	});

	it("resolves a real worker wait from main and reports ownership on both sides", async () => {
		const { worker, probe } = await startWorker();
		expect(await probe.threadId()).toBe(worker.threadId);

		const outgoing = request({ messageId: "from-worker", ownerId: "worker-owner" });
		await probe.register(outgoing);
		expect(mainRegistry().hasOwner("worker-owner")).toBe(true);
		expect(await probe.hasOwner("worker-owner")).toBe(true);

		const waiting = probe.wait(outgoing.messageId);
		await waitFor(() => mainRegistry().hasWaiter(outgoing.messageId));
		expect(await mainRegistry().resolve(outgoing.messageId, outgoing.peer, "exact from main")).toBe(true);
		expect(await waiting).toBe("exact from main");
		expect(mainRegistry().hasOwner("worker-owner")).toBe(false);
		expect(await probe.hasOwner("worker-owner")).toBe(false);
		expect(mainRegistry().hasWaiter(outgoing.messageId)).toBe(false);
	});

	it("drops a dead worker's entry and waiter and leaves another worker's request live", async () => {
		const first = await startWorker();
		const second = await startWorker();
		const dead = request({ messageId: "dead-msg", peer: "peer-dead", ownerId: "dead-owner", jobId: "dead-job" });
		const live = request({ messageId: "live-msg", peer: "peer-live", ownerId: "live-owner", jobId: "live-job" });
		await first.probe.register(dead);
		await second.probe.register(live);
		const deadWait = first.probe.wait(dead.messageId);
		const liveWait = second.probe.wait(live.messageId);
		await waitFor(() => mainRegistry().hasWaiter(dead.messageId) && mainRegistry().hasWaiter(live.messageId));

		first.worker.terminate("killed by test");
		await expect(deadWait).rejects.toThrow();

		const registry = mainRegistry();
		expect(registry.hasOwner("dead-owner")).toBe(false);
		expect(registry.hasWaiter(dead.messageId)).toBe(false);
		expect(await registry.resolve(dead.messageId, dead.peer, "too late")).toBe(false);
		expect(registry.hasOwner("live-owner")).toBe(true);
		expect(await second.probe.hasOwner("live-owner")).toBe(true);

		expect(await registry.resolve(live.messageId, live.peer, "still live")).toBe(true);
		expect(await liveWait).toBe("still live");
		expect(registry.hasOwner("live-owner")).toBe(false);
	});

	it("detaches a cancelled remote wait and drops the entry when the reply arrives", async () => {
		const { probe } = await startWorker();
		const outgoing = request({ messageId: "abort-me", ownerId: "abort-owner" });
		await probe.register(outgoing);
		await probe.beginCancellableWait(outgoing.messageId);
		await waitFor(() => mainRegistry().hasWaiter(outgoing.messageId));

		await probe.abortWait(outgoing.messageId);
		await waitFor(() => !mainRegistry().hasWaiter(outgoing.messageId));
		expect(mainRegistry().hasOwner("abort-owner")).toBe(true);
		await waitFor(async () => (await probe.waitState(outgoing.messageId)) === "rejected");

		expect(await mainRegistry().resolve(outgoing.messageId, outgoing.peer, "after abort")).toBe(true);
		expect(mainRegistry().hasWaiter(outgoing.messageId)).toBe(false);
		expect(mainRegistry().hasOwner("abort-owner")).toBe(false);
		// An unref'd worker does not deliver a nested reply to an idle loop; poll, as waitFor does.
		const pending = probe.wait(outgoing.messageId);
		let settled = false;
		pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await waitFor(() => settled);
		await expect(pending).rejects.toThrow("unknown outgoing request");
	});
	it("completes a worker-originated request from main dispatch without an IRC copy", async () => {
		const { probe } = await startWorker();
		const outgoing = request({
			messageId: "from-worker",
			peer: "beta",
			ownerId: "worker-owner",
			jobId: "job-worker",
		});
		await probe.register(outgoing);
		const waiting = probe.wait(outgoing.messageId);
		const settled = waiting.then(
			text => text,
			() => undefined,
		);
		const bus: string[] = [];
		const now = Date.now();
		const main = {
			id: "Main",
			generation: 1,
			displayName: "Main Alias",
			kind: "main" as const,
			parentId: "Main",
			status: "idle" as const,
			session: null,
			sessionFile: null,
			createdAt: now,
			lastActivity: now,
		};
		try {
			const task = await sendA2aMessage(
				{
					message: { messageId: "reply-worker", role: "ROLE_USER", parts: [{ text: "worker answer" }] },
					metadata: { to: "Main", from: "beta", inReplyTo: outgoing.messageId },
				},
				{
					registry: {
						get: (id: string) => (id === "Main" ? main : undefined),
						list: () => [main],
						setStatus: () => false,
					},
					send: async message => {
						bus.push(message.body);
						return { to: message.to, outcome: "injected" as const };
					},
					outgoing: OutgoingRequests.global(),
				},
			);
			expect(bus).toEqual([]);
			expect(task.metadata).toMatchObject({ delivery: { outcome: "injected" } });
			expect(await waiting).toBe("worker answer");
			expect(mainRegistry().hasOwner("worker-owner")).toBe(false);
			expect(await probe.hasOwner("worker-owner")).toBe(false);
		} finally {
			await OutgoingRequests.global().cancel(outgoing.messageId);
			await settled;
		}
	});
});
