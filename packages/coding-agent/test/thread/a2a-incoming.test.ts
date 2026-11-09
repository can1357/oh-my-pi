import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IncomingRequests } from "../../src/a2a/incoming-requests";
import type { ThreadService } from "../../src/thread/services";
import { a2aIncomingThreadService } from "../../src/thread/services/a2a-incoming";
import { executorThreadService } from "../../src/thread/services/executor";
import { getThreadServices } from "../../src/thread/services/index";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { IncomingProbe, IncomingProbeGlobals } from "../fixtures/a2a-incoming-worker";

const workers: SubagentWorker[] = [];
beforeEach(() => IncomingRequests.resetGlobalForTests());
afterEach(() => {
	for (const worker of workers.splice(0)) worker.terminate("test end");
	IncomingRequests.resetGlobalForTests();
});

async function startWorker(): Promise<IncomingProbe> {
	const probe = Promise.withResolvers<IncomingProbe>();
	const probeService: ThreadService = {
		name: "a2a-incoming-probe",
		globals: (): IncomingProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/a2a-incoming-worker.ts", import.meta.url),
		services: [a2aIncomingThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	workers.push(worker);
	await worker.ready;
	return probe.promise;
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
		const fromMain = { to: "worker-agent", from: "peer", messageId: "main-note", at: 1 };
		const fromWorker = { to: "main-agent", from: "peer", messageId: "worker-note", at: 2 };
		await main.note(fromMain);
		await first.note(fromWorker);
		expect(await second.list()).toEqual([fromMain, fromWorker]);
		expect(await first.consume({ to: "worker-agent", messageId: "main-note" })).toEqual(fromMain);
		expect(await main.consume({ to: "main-agent" })).toEqual(fromWorker);
		expect(await second.list()).toEqual([]);
	});

	it("allows only one worker or main to consume the same request", async () => {
		const worker = await startWorker();
		const main = IncomingRequests.global();
		const request = { to: "agent", from: "peer", messageId: "race", at: 1 };
		await main.note(request);
		const results = await Promise.all([worker.consume({ to: "agent" }), main.consume({ to: "agent" })]);
		expect(results.filter(result => result !== undefined)).toEqual([request]);
	});
});
