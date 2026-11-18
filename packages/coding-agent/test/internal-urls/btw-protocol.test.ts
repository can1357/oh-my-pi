import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BtwProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/btw-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { InternalUrl, ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { type BtwHistoryRecord, BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function url(input: string): InternalUrl {
	return parseInternalUrl(input);
}

function context(
	artifactsDir: string,
	options: { taskDepth?: number; sessionId?: string | null } = {},
): ResolveContext {
	const sessionId = options.sessionId === undefined ? "main-session" : options.sessionId;
	const session = {
		taskDepth: options.taskDepth ?? 0,
		getSessionId: () => sessionId,
		getArtifactsDir: () => artifactsDir,
	} as unknown as ToolSession;
	return { sessionId: sessionId ?? undefined, session };
}

function record(id: string, overrides: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord {
	return {
		id,
		question: `Question ${id}`,
		answer: `Answer ${id}`,
		status: "complete",
		createdAt: 1,
		updatedAt: 2,
		leafId: "leaf",
		...overrides,
	};
}

describe("BtwProtocolHandler", () => {
	let root: string;
	let artifactsDir: string;
	let handler: BtwProtocolHandler;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-url-"));
		artifactsDir = path.join(root, "session");
		handler = new BtwProtocolHandler();
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("is registered so read resolves it like every other internal scheme", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		await store.upsert(record("registered", { question: "Registered question" }));

		const resource = await InternalUrlRouter.instance().resolve("btw://", context(artifactsDir));

		expect(resource.content).toContain("Registered question");
	});

	it("lists topics newest first with the latest answer preview", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		await store.upsert(record("older", { question: "Older question", createdAt: 1, updatedAt: 1 }));
		await store.upsert(
			record("newer", {
				question: "Newer question",
				answer: "Newest answer",
				createdAt: 10,
				updatedAt: 11,
				followUps: [
					{
						question: "Follow-up question",
						answer: "Follow-up answer",
						status: "complete",
						createdAt: 12,
						updatedAt: 13,
					},
				],
			}),
		);

		const resource = await handler.resolve(url("btw://"), context(artifactsDir));

		expect(resource.content.indexOf("btw://newer")).toBeLessThan(resource.content.indexOf("btw://older"));
		expect(resource.content).toContain("latest answer: Follow-up answer");
		expect(resource.content).toContain("turns: 2");
	});

	it("returns every turn with full answers for one topic", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		await store.upsert(
			record("topic", {
				title: "/sitrep",
				question: "Opening question",
				answer: "Opening answer",
				followUps: [
					{
						question: "Second question",
						answer: "Second answer",
						status: "complete",
						createdAt: 3,
						updatedAt: 4,
					},
				],
			}),
		);

		const resource = await handler.resolve(url("btw://topic"), context(artifactsDir));

		expect(resource.content).toContain("title: /sitrep");
		expect(resource.content).toContain("--- turn 1 (complete) ---");
		expect(resource.content).toContain("Opening answer");
		expect(resource.content).toContain("--- turn 2 (complete) ---");
		expect(resource.content).toContain("Second answer");
	});

	it("keeps a subagent's topics separate from the main session's", async () => {
		const mainStore = await BtwHistoryStore.open(artifactsDir);
		await mainStore.upsert(record("main-topic", { question: "Main question" }));
		const workerStore = await BtwHistoryStore.open(artifactsDir, "worker-session");
		await workerStore.upsert(record("worker-topic", { question: "Worker question" }));

		const main = await handler.resolve(url("btw://"), context(artifactsDir));
		expect(main.content).toContain("Main question");
		expect(main.content).not.toContain("Worker question");

		const worker = await handler.resolve(
			url("btw://"),
			context(artifactsDir, { taskDepth: 1, sessionId: "worker-session" }),
		);
		expect(worker.content).toContain("Worker question");
		expect(worker.content).not.toContain("Main question");

		await expect(
			handler.resolve(url("btw://"), context(artifactsDir, { taskDepth: 1, sessionId: null })),
		).rejects.toThrow("this subagent has no session id");
	});

	it("reports unknown topics and rejects URL shapes that are not a topic id", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		await store.upsert(record("known"));

		await expect(handler.resolve(url("btw://missing"), context(artifactsDir))).rejects.toThrow(
			"Unknown /btw topic: missing\nAvailable: known",
		);
		await expect(handler.resolve(url("btw://known/extra"), context(artifactsDir))).rejects.toThrow(
			"takes a topic id only",
		);
		await expect(handler.resolve(url("btw://known?raw=1"), context(artifactsDir))).rejects.toThrow(
			"takes no query or fragment",
		);
	});
});
