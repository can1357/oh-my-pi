import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";

import { CaptureStore } from "../src/capture/store";
import type { CaptureRun } from "../src/capture/types";
import { tempDataDir } from "./helpers/capture-fakes";

function sampleRun(overrides: Partial<CaptureRun> = {}): CaptureRun {
	const now = "2026-07-11T00:00:00.000Z";
	return {
		id: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		instruction: "Investigate this error",
		sourceType: "screen-region",
		status: "queued",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("CaptureStore", () => {
	it("creates runs idempotently by requestId", () => {
		const store = new CaptureStore({ dataDir: tempDataDir() });
		const run = sampleRun();
		const first = store.createRun(run.requestId, { raw: true }, run);
		expect(first.created).toBe(true);

		const replay = store.createRun(run.requestId, { raw: true }, sampleRun({ requestId: run.requestId }));
		expect(replay.created).toBe(false);
		expect(replay.run.id).toBe(run.id);
		store.close();
	});

	it("persists run mappings across store restarts", () => {
		const dataDir = tempDataDir();
		const run = sampleRun({
			sessionId: "session-abc",
			sessionFile: "/tmp/sessions/session-abc.jsonl",
			telegramChatId: "-100123",
			telegramRootMessageId: "42",
		});
		{
			const store = new CaptureStore({ dataDir });
			store.createRun(run.requestId, undefined, run);
			store.recordCollabMessage("telegram", "-100123", "42", run.id, "root");
			store.close();
		}
		{
			const store = new CaptureStore({ dataDir });
			const loaded = store.getRun(run.id);
			expect(loaded?.sessionId).toBe("session-abc");
			expect(loaded?.sessionFile).toBe("/tmp/sessions/session-abc.jsonl");
			expect(store.findRunIdByCollabMessage("telegram", "-100123", "42")).toBe(run.id);
			expect(store.findLatestRunForChat("-100123")?.id).toBe(run.id);
			store.close();
		}
	});

	it("updates runs with partial patches", () => {
		const store = new CaptureStore({ dataDir: tempDataDir() });
		const run = sampleRun();
		store.createRun(run.requestId, undefined, run);
		const updated = store.updateRun(run.id, { status: "running", sessionId: "s-1" });
		expect(updated?.status).toBe("running");
		expect(updated?.sessionId).toBe("s-1");
		// Fields not in the patch are preserved.
		expect(store.getRun(run.id)?.instruction).toBe(run.instruction);
		store.close();
	});

	it("appends and lists events with monotonic sequence numbers", () => {
		const store = new CaptureStore({ dataDir: tempDataDir() });
		const run = sampleRun();
		store.createRun(run.requestId, undefined, run);
		const seq1 = store.appendEvent(run.id, { type: "run.status", runId: run.id, status: "starting" });
		const seq2 = store.appendEvent(run.id, { type: "run.status", runId: run.id, status: "running" });
		expect(seq2).toBeGreaterThan(seq1);
		const events = store.listEvents(run.id);
		expect(events.map(entry => entry.event.type)).toEqual(["run.status", "run.status"]);
		expect(store.listEvents(run.id, seq1)).toHaveLength(1);
		store.close();
	});

	it("stores screenshot assets on disk and enforces retention", async () => {
		const dataDir = tempDataDir();
		const past = "2026-06-01T00:00:00.000Z";
		let now = past;
		const store = new CaptureStore({ dataDir, now: () => now });
		const asset = await store.saveAsset(new Uint8Array([1, 2, 3]), "image/png", { width: 10, height: 20 });
		expect(fs.existsSync(asset.filePath)).toBe(true);
		expect(store.getAsset(asset.id)?.width).toBe(10);

		now = "2026-07-11T00:00:00.000Z";
		const removed = await store.cleanupExpiredAssets(14, new Date(now));
		expect(removed).toBe(1);
		expect(store.getAsset(asset.id)).toBeUndefined();
		expect(fs.existsSync(asset.filePath)).toBe(false);
		store.close();
	});

	it("rejects asset ids that are not generated ids", () => {
		const store = new CaptureStore({ dataDir: tempDataDir() });
		expect(store.getAsset("../../etc/passwd")).toBeUndefined();
		expect(store.getAsset("..%2f..%2fescape")).toBeUndefined();
		store.close();
	});

	it("claims Telegram update ids exactly once", () => {
		const store = new CaptureStore({ dataDir: tempDataDir() });
		expect(store.claimTelegramUpdate(1001)).toBe(true);
		expect(store.claimTelegramUpdate(1001)).toBe(false);
		expect(store.claimTelegramUpdate(1002)).toBe(true);
		store.close();
	});

	it("claims follow-up idempotency keys durably across restarts and releases them", () => {
		const dataDir = tempDataDir();
		{
			const store = new CaptureStore({ dataDir });
			expect(store.claimFollowUpKey("run-1", "telegram:5")).toBe(true);
			expect(store.claimFollowUpKey("run-1", "telegram:5")).toBe(false);
			// Same key under a different run is independent.
			expect(store.claimFollowUpKey("run-2", "telegram:5")).toBe(true);
			store.close();
		}
		{
			// A restart must still see the earlier reservation (in-memory would forget it).
			const store = new CaptureStore({ dataDir });
			expect(store.claimFollowUpKey("run-1", "telegram:5")).toBe(false);
			store.releaseFollowUpKey("run-1", "telegram:5");
			expect(store.claimFollowUpKey("run-1", "telegram:5")).toBe(true);
			store.close();
		}
	});

	it("resolves the latest run per chat and topic", () => {
		const store = new CaptureStore({ dataDir: tempDataDir() });
		const older = sampleRun({ telegramChatId: "-1", createdAt: "2026-07-01T00:00:00.000Z" });
		const newer = sampleRun({ telegramChatId: "-1", createdAt: "2026-07-10T00:00:00.000Z" });
		const topical = sampleRun({
			telegramChatId: "-1",
			telegramTopicId: "77",
			createdAt: "2026-07-05T00:00:00.000Z",
		});
		for (const run of [older, newer, topical]) store.createRun(run.requestId, undefined, run);
		expect(store.findLatestRunForChat("-1")?.id).toBe(newer.id);
		expect(store.findLatestRunForChat("-1", "77")?.id).toBe(topical.id);
		store.close();
	});

	it("records an audit trail per run", () => {
		const store = new CaptureStore({ dataDir: tempDataDir() });
		const run = sampleRun();
		store.createRun(run.requestId, undefined, run);
		store.audit("task.created", { runId: run.id, actor: "@alice" });
		store.audit("task.cancelled", { runId: run.id, actor: "@bob", detail: "from telegram" });
		const entries = store.listAudit(run.id);
		expect(entries.map(entry => entry.action)).toEqual(["task.created", "task.cancelled"]);
		expect(entries[1]?.actor).toBe("@bob");
		store.close();
	});
});
