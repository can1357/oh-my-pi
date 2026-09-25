import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BtwHistoryRecord, BtwHistoryStore, getBtwCopyText } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { acquireFileLock, withFileLock } from "@oh-my-pi/pi-utils";

describe("BtwHistoryStore", () => {
	let directory: string;
	let artifactsDir: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-history-"));
		artifactsDir = path.join(directory, "session");
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	function record(id: string, overrides: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord {
		return {
			id,
			question: `Question ${id}`,
			answer: `Answer ${id}`,
			status: "complete",
			createdAt: 1,
			updatedAt: 2,
			leafId: "main-leaf",
			...overrides,
		};
	}

	it("retains every entry after reopen without changing the main journal", async () => {
		const journalPath = `${artifactsDir}.jsonl`;
		const journal = '{"type":"session","id":"session"}\n';
		await Bun.write(journalPath, journal);
		const store = await BtwHistoryStore.open(artifactsDir);
		const first = record("first");
		const newerB = record("newer-b", { createdAt: 10, updatedAt: 11 });
		const newerA = record("newer-a", { createdAt: 10, updatedAt: 12, status: "error", error: "Connection lost" });
		await store.upsert(first);
		await store.upsert(newerB);
		await store.upsert(newerA);
		await store.upsert({ ...first, answer: "Revised answer", updatedAt: 20 });
		await store.flush();

		const reopened = await BtwHistoryStore.open(artifactsDir);
		expect(reopened.getRecords()).toEqual([newerA, newerB, { ...first, answer: "Revised answer", updatedAt: 20 }]);
		expect(await Bun.file(journalPath).text()).toBe(journal);
	});

	it("does not let a recovered view steal a live turn and preserves the owner's terminal answer", async () => {
		const writer = await BtwHistoryStore.open(artifactsDir);
		const running = record("running", { status: "running", answer: "Partial answer" });
		await writer.upsert(running);
		const recovered = await BtwHistoryStore.open(artifactsDir);
		const recoveredView = recovered.getRecords();
		expect(recoveredView).toEqual([{ ...running, status: "interrupted" }]);

		const followUp = {
			question: "Continue the recovered topic",
			answer: "",
			status: "running" as const,
			createdAt: 4,
			updatedAt: 4,
		};
		await expect(recovered.upsert({ ...recoveredView[0]!, followUps: [followUp] })).rejects.toThrow(
			"Failed to acquire lock",
		);
		expect(recovered.getRecords()).toBe(recoveredView);

		const complete = { ...running, status: "complete" as const, answer: "Final answer", updatedAt: 3 };
		await writer.upsert(complete);
		const reopened = await BtwHistoryStore.open(artifactsDir);
		expect(reopened.getRecords()).toEqual([complete]);
		await reopened.upsert({ ...complete, followUps: [followUp] });
		const finished = {
			...complete,
			followUps: [{ ...followUp, status: "complete" as const, answer: "Next answer" }],
		};
		await reopened.upsert(finished);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([finished]);
	}, 10_000);

	it("does not lose independent entries written by stores opened before either write", async () => {
		const left = await BtwHistoryStore.open(artifactsDir);
		const right = await BtwHistoryStore.open(artifactsDir);
		const first = record("left");
		const second = record("right", { status: "cancelled", answer: "Partial cancelled answer" });
		await Promise.all([left.upsert({ ...first, status: "running" }), right.upsert({ ...second, status: "running" })]);
		await Promise.all([left.upsert(first), right.upsert(second)]);
		await Promise.all([left.flush(), right.flush()]);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([first, second]);
	});

	it("rejects a colliding new topic instead of replacing another store's completed turn", async () => {
		const owner = await BtwHistoryStore.open(artifactsDir);
		const contender = await BtwHistoryStore.open(artifactsDir);
		const running = record("shared", { status: "running", answer: "Owner partial" });
		await owner.upsert(running);
		const attempted = contender.upsert({ ...running, question: "Different question" });
		void attempted.catch(() => {});
		const complete = { ...running, status: "complete" as const, answer: "Owner answer" };
		await owner.upsert(complete);
		await expect(attempted).rejects.toThrow("BTW history conflict");
		await expect(contender.retry({ ...running, status: "complete" })).rejects.toThrow("BTW history conflict");
		await expect(contender.flush()).rejects.toThrow("BTW history conflict");
		expect(contender.getRecords()).toEqual([]);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([complete]);
	});

	it("rejects causal follow-ups from a stale store after another store commits", async () => {
		const owner = await BtwHistoryStore.open(artifactsDir);
		const original = record("topic");
		await owner.upsert(original);
		const stale = await BtwHistoryStore.open(artifactsDir);
		const staleView = stale.getRecords();
		const followUp = {
			question: "Owner follow-up",
			answer: "Owner continuation",
			status: "complete" as const,
			createdAt: 3,
			updatedAt: 4,
		};
		const committed = { ...original, followUps: [followUp] };
		await owner.upsert(committed);
		await expect(
			stale.upsert({ ...staleView[0]!, followUps: [{ ...followUp, question: "Stale follow-up" }] }),
		).rejects.toThrow("BTW history conflict");
		await expect(stale.retry({ ...original, answer: "Stale terminal answer" })).rejects.toThrow(
			"BTW history conflict",
		);
		await expect(stale.flush()).rejects.toThrow("BTW history conflict");
		expect(stale.getRecords()).toBe(staleView);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([committed]);
	});

	it("appends to a crash-recovered record using the original raw revision after ownership releases", async () => {
		const filePath = path.join(artifactsDir, "btw-history", "entry-crashed.json");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const lease = await acquireFileLock(filePath);
		let recovered: BtwHistoryStore;
		const running = record("crashed", { status: "running", answer: "Crash partial" });
		try {
			await Bun.write(filePath, JSON.stringify(running, null, 2));
			recovered = await BtwHistoryStore.open(artifactsDir);
			expect(recovered.getRecords()[0]?.status).toBe("interrupted");
		} finally {
			lease.release();
		}
		const continued = {
			...recovered.getRecords()[0]!,
			followUps: [
				{
					question: "Resume after the crash",
					answer: "Recovered continuation",
					status: "complete" as const,
					createdAt: 3,
					updatedAt: 4,
				},
			],
		};
		await recovered.upsert(continued);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([continued]);
	});

	it("does not resurrect a deleted record from a stale store", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const saved = record("deleted");
		await store.upsert(saved);
		const oldView = store.getRecords();
		const filePath = path.join(artifactsDir, "btw-history", "entry-deleted.json");
		await withFileLock(filePath, () => fs.rm(filePath));
		await expect(store.upsert({ ...saved, answer: "Resurrected" })).rejects.toThrow("BTW history conflict");
		expect(store.getRecords()).toBe(oldView);
		expect(await Bun.file(filePath).exists()).toBe(false);
	});

	it("captures streaming snapshots before queued writes and keeps old views stable", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const streaming = record("streaming", { status: "running", answer: "Captured partial" });
		const pending = store.upsert(streaming);
		expect(store.getRecords()).toEqual([]);
		streaming.answer = "Uncheckpointed text";
		streaming.status = "complete";
		await pending;
		const oldView = store.getRecords();
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()[0]).toEqual({
			...streaming,
			answer: "Captured partial",
			status: "interrupted",
		});

		await store.upsert(streaming);
		expect(oldView[0]?.answer).toBe("Captured partial");
		expect(oldView[0]?.status).toBe("running");
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([streaming]);
	});

	it("keeps the committed snapshot visible while an update waits for the topic lock", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const saved = record("topic");
		await store.upsert(saved);
		const oldView = store.getRecords();
		const filePath = path.join(artifactsDir, "btw-history", "entry-topic.json");
		let writing: Promise<void> | undefined;
		await withFileLock(filePath, async () => {
			writing = store.upsert({ ...saved, answer: "Committed later" });
			expect(store.getRecords()).toBe(oldView);
			expect(await Bun.file(filePath).json()).toEqual(saved);
		});
		await writing;
		expect(oldView).toEqual([saved]);
		expect(store.getRecords()[0]?.answer).toBe("Committed later");
	});

	it("publishes immutable memory-only snapshots immediately", async () => {
		const store = await BtwHistoryStore.open(undefined);
		const streaming = record("memory", { status: "running", answer: "Checkpoint" });
		const writing = store.upsert(streaming);
		const oldView = store.getRecords();
		streaming.answer = "Uncheckpointed";
		expect(oldView[0]?.answer).toBe("Checkpoint");
		await writing;
		await store.upsert({ ...streaming, status: "complete" });
		expect(oldView[0]?.status).toBe("running");
		expect(store.getRecords()[0]?.answer).toBe("Uncheckpointed");
	});

	it("snapshots nested follow-ups and recovers only unfinished turns", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const followUp = {
			question: "Continue this topic",
			answer: "Partial",
			status: "running" as const,
			createdAt: 3,
			updatedAt: 4,
		};
		const topic = record("topic", { followUps: [followUp] });
		const writing = store.upsert(topic);
		followUp.answer = "Uncheckpointed";
		await writing;
		expect(store.getRecords()[0]?.followUps?.[0]?.answer).toBe("Partial");
		const recovered = (await BtwHistoryStore.open(artifactsDir)).getRecords()[0]!;
		expect(recovered.status).toBe("complete");
		expect(recovered.answer).toBe("Answer topic");
		expect(recovered.followUps).toEqual([{ ...followUp, answer: "Partial", status: "interrupted" }]);
		const raw = await Bun.file(path.join(artifactsDir, "btw-history", "entry-topic.json")).json();
		expect(raw.followUps[0].status).toBe("running");
		await store.upsert({ ...topic, followUps: [{ ...followUp, status: "complete" }] });
	});

	it("copies the last nonblank answer without stripping its whitespace", () => {
		const topic = record("copy", {
			answer: "  Root answer\n",
			followUps: [
				{ question: "Answered", answer: "\n Follow-up answer \n", status: "complete", createdAt: 3, updatedAt: 4 },
				{ question: "Unanswered", answer: " \t\n", status: "cancelled", createdAt: 5, updatedAt: 6 },
				{ question: "Still running", answer: "", status: "running", createdAt: 7, updatedAt: 7 },
			],
		});
		expect(getBtwCopyText(topic)).toBe("\n Follow-up answer \n");
		expect(getBtwCopyText({ ...topic, followUps: topic.followUps!.slice(1) })).toBe("  Root answer\n");
		expect(getBtwCopyText({ ...topic, answer: "\t", followUps: topic.followUps!.slice(1) })).toBeUndefined();
	});

	it("surfaces malformed JSON without replacing any saved bytes", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		await store.upsert(record("valid", { status: "running" }));
		const corruptPath = path.join(artifactsDir, "btw-history", "entry-corrupt.json");
		const invalid = '{"id":"corrupt",';
		await Bun.write(corruptPath, invalid);
		const validPath = path.join(artifactsDir, "btw-history", "entry-valid.json");
		const validBefore = await Bun.file(validPath).text();

		await expect(BtwHistoryStore.open(artifactsDir)).rejects.toThrow("Failed to read BTW history");
		expect(await Bun.file(corruptPath).text()).toBe(invalid);
		expect(await Bun.file(validPath).text()).toBe(validBefore);
		await store.upsert(record("valid"));
	});

	it("rejects unknown fields, invalid status, nonfinite timestamps, and mismatched identities", async () => {
		const historyDir = path.join(artifactsDir, "btw-history");
		await fs.mkdir(historyDir, { recursive: true });
		const filePath = path.join(historyDir, "entry-record.json");
		const malformed = [
			JSON.stringify({ ...record("record"), injectedContext: "must not persist" }),
			JSON.stringify({ ...record("record"), status: "queued" }),
			JSON.stringify(record("record")).replace('"createdAt":1', '"createdAt":1e999'),
			JSON.stringify(record("different-id")),
		];
		for (const content of malformed) {
			await Bun.write(filePath, content);
			await expect(BtwHistoryStore.open(artifactsDir)).rejects.toThrow("Failed to read BTW history");
			expect(await Bun.file(filePath).text()).toBe(content);
		}
	});

	it.each([
		["root", "createdAt"],
		["root", "updatedAt"],
		["follow-up", "createdAt"],
		["follow-up", "updatedAt"],
	] as const)("rejects an out-of-range %s %s before publishing or loading history", async (scope, field) => {
		const original = record("range");
		const turn = { question: "Follow-up", answer: "Answer", status: "complete" as const, createdAt: 1, updatedAt: 2 };
		const invalid =
			scope === "root"
				? { ...original, [field]: 8.64e15 + 1 }
				: { ...original, followUps: [{ ...turn, [field]: 8.64e15 + 1 }] };
		const store = await BtwHistoryStore.open(artifactsDir);
		await store.upsert(original);
		await expect(store.upsert(invalid)).rejects.toThrow("Invalid BTW history record");
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([original]);

		const filePath = path.join(artifactsDir, "btw-history", "entry-range.json");
		const bytes = JSON.stringify(invalid);
		await Bun.write(filePath, bytes);
		await expect(BtwHistoryStore.open(artifactsDir)).rejects.toThrow("Invalid BTW history record");
		expect(await Bun.file(filePath).text()).toBe(bytes);
	});

	it("preserves the inclusive Date range boundaries across reopen", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const saved = record("range", {
			createdAt: 0,
			updatedAt: 8.64e15,
			followUps: [
				{ question: "Follow-up", answer: "Answer", status: "complete", createdAt: 8.64e15, updatedAt: 8.64e15 },
			],
		});
		await store.upsert(saved);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([saved]);
	});

	it("rejects traversal ids before creating files or accepting the record", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		await expect(store.upsert(record("../../outside"))).rejects.toThrow("Invalid BTW history record id");
		expect(store.getRecords()).toEqual([]);
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it("retains write failures through flush and refuses to overwrite later corruption", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const saved = record("saved", { status: "running" });
		await store.upsert(saved);
		const filePath = path.join(artifactsDir, "btw-history", "entry-saved.json");
		const savedBytes = await Bun.file(filePath).text();
		await Bun.write(filePath, "broken");
		await expect(store.upsert({ ...saved, answer: "Replacement" })).rejects.toThrow("Failed to read BTW history");
		await expect(store.retry({ ...saved, answer: "Replacement" })).rejects.toThrow("Failed to read BTW history");
		await expect(store.flush()).rejects.toThrow("Failed to read BTW history");
		await expect(store.upsert(record("later"))).rejects.toThrow("Failed to read BTW history");
		await expect(store.flush()).rejects.toThrow("Failed to read BTW history");
		expect(await Bun.file(filePath).text()).toBe("broken");
		expect(store.getRecords()).toEqual([saved]);
		expect((await fs.readdir(path.dirname(filePath))).filter(name => !name.endsWith(".lock"))).toEqual([
			"entry-saved.json",
		]);
		await withFileLock(
			filePath,
			async () => {
				await Bun.write(filePath, savedBytes);
			},
			{ retries: 1 },
		);
		await expect(store.flush()).rejects.toThrow("Failed to read BTW history");
		const finished = { ...saved, answer: "Recovered after error", status: "complete" as const };
		await expect(store.upsert(finished)).rejects.toThrow("Failed to read BTW history");
		await store.retry(finished);
		await store.flush();
		expect(store.getRecords()).toEqual([finished]);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([finished]);
	});

	it("retries a terminal checkpoint after repairing the filesystem without publishing a failed snapshot", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const running = record("topic", { status: "running", answer: "Checkpointed partial" });
		await store.upsert(running);
		const oldView = store.getRecords();
		const filePath = path.join(artifactsDir, "btw-history", "entry-topic.json");
		const backupPath = path.join(directory, "checkpoint-backup");
		const savedBytes = await Bun.file(filePath).text();
		await fs.rename(filePath, backupPath);
		await fs.mkdir(filePath);
		const terminal = { ...running, status: "complete" as const, answer: "Retained terminal answer" };

		await expect(store.upsert(terminal)).rejects.toThrow("Expected a regular file");
		await expect(store.flush()).rejects.toThrow("Expected a regular file");
		expect(store.getRecords()).toBe(oldView);
		expect(await Bun.file(backupPath).text()).toBe(savedBytes);

		await fs.rm(filePath, { recursive: true });
		await fs.rename(backupPath, filePath);
		await expect(store.flush()).rejects.toThrow("Expected a regular file");
		await expect(store.upsert(terminal)).rejects.toThrow("Expected a regular file");

		const lease = await acquireFileLock(filePath);
		let retry: Promise<void>;
		try {
			retry = store.retry(terminal);
			expect(store.getRecords()).toBe(oldView);
			expect(await Bun.file(filePath).text()).toBe(savedBytes);
			terminal.answer = "Uncheckpointed mutation";
		} finally {
			lease.release();
		}
		await retry;
		await store.flush();
		const committed = { ...terminal, answer: "Retained terminal answer" };
		expect(store.getRecords()).toEqual([committed]);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([committed]);
		expect(oldView).toEqual([running]);
	});

	it("keeps a later failed retry sticky after an earlier retry succeeds", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const saved = record("topic");
		await store.upsert(saved);
		const filePath = path.join(artifactsDir, "btw-history", "entry-topic.json");
		const savedBytes = await Bun.file(filePath).text();
		await Bun.write(filePath, "broken");
		await expect(store.upsert({ ...saved, answer: "Failed checkpoint" })).rejects.toThrow(
			"Failed to read BTW history",
		);
		await Bun.write(filePath, savedBytes);
		const collisionPath = path.join(artifactsDir, "btw-history", "entry-collision.json");
		const collisionBytes = JSON.stringify(record("collision", { answer: "Another writer's answer" }));
		await Bun.write(collisionPath, collisionBytes);

		const terminal = { ...saved, answer: "Retried checkpoint" };
		const successful = store.retry(terminal);
		const conflicting = store.retry(record("collision"));
		const failedRetry = expect(conflicting).rejects.toThrow("BTW history conflict");
		const failedFlush = expect(store.flush()).rejects.toThrow("BTW history conflict");
		await successful;
		await failedRetry;
		await failedFlush;
		await expect(store.upsert({ ...terminal, answer: "Must remain blocked" })).rejects.toThrow(
			"BTW history conflict",
		);
		expect(store.getRecords()).toEqual([terminal]);
		expect(await Bun.file(filePath).json()).toEqual(terminal);
		expect(await Bun.file(collisionPath).text()).toBe(collisionBytes);
	});

	it("publishes private records and removes staged files after queued writes drain", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const first = store.upsert(record("first"));
		const second = store.upsert(record("second"));
		await store.flush();
		await Promise.all([first, second]);
		const historyDir = path.join(artifactsDir, "btw-history");
		expect((await fs.readdir(historyDir)).filter(name => !name.endsWith(".lock")).sort()).toEqual([
			"entry-first.json",
			"entry-second.json",
		]);
		if (process.platform !== "win32") {
			expect((await fs.stat(historyDir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(historyDir, "entry-first.json"))).mode & 0o777).toBe(0o600);
		}
	});
});
