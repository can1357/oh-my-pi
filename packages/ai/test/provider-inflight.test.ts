import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@pk-nerdsaver-ai/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import {
	__providerInFlightForTesting,
	configureProviderMaxInFlightRequests,
	streamSimple,
} from "@pk-nerdsaver-ai/pi-ai/stream";
import type { Context } from "@pk-nerdsaver-ai/pi-ai/types";

function context(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

let limiterRoot: string | undefined;

afterEach(async () => {
	clearCustomApis();
	configureProviderMaxInFlightRequests(undefined);
	__providerInFlightForTesting.setRoot(undefined);
	if (limiterRoot !== undefined) {
		await fs.rm(limiterRoot, { recursive: true, force: true });
		limiterRoot = undefined;
	}
});

async function useIsolatedLimiterRoot(): Promise<void> {
	limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-inflight-test-"));
	__providerInFlightForTesting.setRoot(limiterRoot);
}

function limiterDir(provider: string): string {
	return __providerInFlightForTesting.providerDir(provider);
}

describe("provider in-flight request limits", () => {
	beforeEach(async () => {
		await useIsolatedLimiterRoot();
	});
	test("serializes concurrent streamSimple calls for the same provider", async () => {
		registerMockApi();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		let callIndex = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				callIndex++;
				active++;
				maxActive = Math.max(maxActive, active);
				try {
					if (callIndex === 1) {
						firstStarted.resolve();
						await releaseFirst.promise;
					}
					return { content: [`reply ${callIndex}`] };
				} finally {
					active--;
				}
			},
		});

		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		const firstResult = first.result();
		await firstStarted.promise;

		const second = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		await Bun.sleep(20);
		expect(mock.calls).toHaveLength(1);

		releaseFirst.resolve();
		const [firstMessage, secondMessage] = await Promise.all([firstResult, second.result()]);

		expect(firstMessage.content).toEqual([{ type: "text", text: "reply 1" }]);
		expect(secondMessage.content).toEqual([{ type: "text", text: "reply 2" }]);
		expect(maxActive).toBe(1);
		expect(mock.calls).toHaveLength(2);
	});

	test("removes an aborted queued request without dispatching it", async () => {
		registerMockApi();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let callIndex = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				callIndex++;
				if (callIndex === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return { content: [`reply ${callIndex}`] };
			},
		});

		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		const firstResult = first.result();
		await firstStarted.promise;

		const controller = new AbortController();
		const second = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});
		controller.abort(new Error("cancel queued request"));

		await expect(second.result()).rejects.toThrow("cancel queued request");
		expect(mock.calls).toHaveLength(1);

		releaseFirst.resolve();
		await firstResult;
		expect(mock.calls).toHaveLength(1);
	});

	test("shares limits with leases created by another process", async () => {
		registerMockApi();
		const providerDir = limiterDir("tests");
		const externalLease = path.join(providerDir, "external");
		await fs.mkdir(externalLease, { recursive: true });
		await Bun.write(
			path.join(externalLease, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "external" }),
		);

		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		await Bun.sleep(150);
		expect(mock.calls).toHaveLength(0);

		await fs.rm(externalLease, { recursive: true, force: true });
		await Bun.write(path.join(providerDir, ".wakeup"), String(Date.now()));
		const result = await stream.result();
		expect(result.content).toEqual([{ type: "text", text: "reply" }]);
		expect(mock.calls).toHaveLength(1);
	});

	test("does not signal waiters when no slot was freed", async () => {
		registerMockApi();
		const providerDir = limiterDir("tests");
		const externalLease = path.join(providerDir, "external");
		await fs.mkdir(externalLease, { recursive: true });
		await Bun.write(
			path.join(externalLease, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "external" }),
		);

		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		await Bun.sleep(50);
		expect(await Bun.file(path.join(providerDir, ".wakeup")).exists()).toBe(false);
		expect(mock.calls).toHaveLength(0);

		controller.abort(new Error("cancel saturated waiter"));
		await expect(stream.result()).rejects.toThrow("cancel saturated waiter");
	});

	test("does not signal waiters when acquiring a slot", async () => {
		registerMockApi();
		const providerDir = limiterDir("tests");
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				firstStarted.resolve();
				await releaseFirst.promise;
				return { content: ["reply"] };
			},
		});

		const stream = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		await firstStarted.promise;

		expect(await Bun.file(path.join(providerDir, ".wakeup")).exists()).toBe(false);

		releaseFirst.resolve();
		const result = await stream.result();
		expect(result.content).toEqual([{ type: "text", text: "reply" }]);
	});

	test("does not reap a live lock just because its timestamp is old", async () => {
		registerMockApi();
		const lockDir = __providerInFlightForTesting.lockDir("tests");
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now() - 60_000, token: "live-lock" }),
		);

		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		await Bun.sleep(150);
		expect(mock.calls).toHaveLength(0);

		controller.abort(new Error("cancel lock waiter"));
		await expect(stream.result()).rejects.toThrow("cancel lock waiter");
		expect(mock.calls).toHaveLength(0);
	});

	test("treats unreadable fresh lease info as active", async () => {
		registerMockApi();
		const providerDir = limiterDir("tests");
		const externalLease = path.join(providerDir, "partial-info");
		await fs.mkdir(externalLease, { recursive: true });
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(externalLease, old, old);
		await Bun.write(path.join(externalLease, "info.json"), "{");

		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		await Bun.sleep(150);
		expect(mock.calls).toHaveLength(0);

		controller.abort(new Error("cancel partial-info waiter"));
		await expect(stream.result()).rejects.toThrow("cancel partial-info waiter");
		expect(mock.calls).toHaveLength(0);
	});

	test("does not delete a fresh lock after observing a stale lock", async () => {
		const lockDir = __providerInFlightForTesting.lockDir("tests");
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: 999999, timestamp: Date.now() - 60_000, token: "stale-lock" }),
		);
		const staleRelease = await __providerInFlightForTesting.captureStaleLockRelease("tests");
		expect(staleRelease).not.toBeNull();

		await fs.rm(lockDir, { recursive: true, force: true });
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "fresh-lock" }),
		);

		await staleRelease?.();

		const remaining = JSON.parse(await Bun.file(path.join(lockDir, "info.json")).text()) as { token: string };
		expect(remaining.token).toBe("fresh-lock");
	});

	test("does not delete a fresh lock after a write-failure cleanup observes an old lock", async () => {
		const lockDir = __providerInFlightForTesting.lockDir("tests");
		await fs.mkdir(lockDir, { recursive: true });
		const staleCleanup = await __providerInFlightForTesting.captureLockDirRelease("tests");
		expect(staleCleanup).not.toBeNull();

		await fs.rm(lockDir, { recursive: true, force: true });
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "fresh-lock" }),
		);

		await staleCleanup?.();

		const remaining = JSON.parse(await Bun.file(path.join(lockDir, "info.json")).text()) as { token: string };
		expect(remaining.token).toBe("fresh-lock");
	});

	test("does not dispatch when aborted immediately after slot acquisition", async () => {
		registerMockApi();
		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		controller.abort(new Error("cancel acquired request"));

		await expect(stream.result()).rejects.toThrow("cancel acquired request");
		expect(mock.calls).toHaveLength(0);
	});

	test("uses opaque path segments for provider ids", async () => {
		const dir = limiterDir("..");
		const relative = path.relative(limiterRoot!, dir);

		expect(relative).not.toBe("");
		expect(relative.startsWith("..")).toBe(false);
		expect(path.isAbsolute(relative)).toBe(false);
	});
});
