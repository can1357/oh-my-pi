import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-model-usage-");

const USAGE = {
	input: 11,
	output: 2,
	cacheRead: 3,
	cacheWrite: 0,
	totalTokens: 16,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
};

/** A `model_usage` entry as the session journals it, one per minute of `minute`. */
function modelUsage(id: string, minute: number, fields: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "model_usage",
		id,
		parentId: null,
		timestamp: new Date(Date.UTC(2026, 10, 10, 10, minute)).toISOString(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		stopReason: "stop",
		usage: USAGE,
		...fields,
	};
}

async function writeSession(project: string, entries: Record<string, unknown>[]): Promise<string> {
	const dir = path.join(getSessionsDir(), project);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, entries.map(entry => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

describe("model usage session entries", () => {
	it("parses and aggregates non-transcript model calls", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--model-usage");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		await Bun.write(
			file,
			`${JSON.stringify({
				type: "model_usage",
				id: "classifier-1",
				parentId: null,
				timestamp: "2026-08-31T10:00:00.000Z",
				purpose: "auto-thinking",
				role: "smol",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				stopReason: "error",
				errorMessage: "Internal Server Error",
				usage: {
					input: 11,
					output: 2,
					cacheRead: 3,
					cacheWrite: 0,
					totalTokens: 16,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
				},
			})}\n`,
		);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		expect(getRecentRequests(1)[0]).toMatchObject({
			entryId: "classifier-1",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			stopReason: "error",
			errorMessage: "Internal Server Error",
			usage: { totalTokens: 16, cost: { total: 6 } },
		});
	});

	it("opens a model_usage request in the detail endpoint without a payload", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--model-usage-details");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		await Bun.write(
			file,
			`${JSON.stringify({
				type: "model_usage",
				id: "judge-1",
				parentId: null,
				timestamp: "2026-08-31T10:00:00.000Z",
				purpose: "auto-thinking",
				role: "typesafe",
				api: "typesafe",
				provider: "typesafe",
				model: "jev-latest",
				stopReason: "stop",
				usage: {
					input: 927,
					output: 47,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 974,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			})}\n`,
		);
		await initDb();
		insertMessageStats((await parseSessionFile(file)).stats);
		const [row] = getRecentRequests(1);

		const response = await handleApi(new Request(`http://stats.test/api/request/${row.id}`));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: row.id,
			model: "jev-latest",
			output: null,
			messages: [{ type: "model_usage", id: "judge-1", purpose: "auto-thinking" }],
		});

		await Bun.write(file, "");
		expect((await handleApi(new Request(`http://stats.test/api/request/${row.id}`))).status).toBe(404);
	});

	it("keeps the purpose and timings of model_usage entries and gives assistant turns no purpose", async () => {
		const file = await writeSession("--tmp--model-usage-purpose", [
			modelUsage("title-1", 0, { purpose: "title", duration: 840, ttft: 210 }),
			// Timings of the wrong type are dropped, not stored.
			modelUsage("caption-1", 1, { purpose: "job-caption", duration: "840", ttft: null }),
			// Without a usable purpose the row must still not pass for a conversation turn.
			modelUsage("anonymous-1", 2, { purpose: 7 }),
			{
				type: "message",
				id: "turn-1",
				parentId: null,
				timestamp: "2026-11-10T10:03:00.000Z",
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-haiku-4-5",
					usage: USAGE,
					stopReason: "stop",
					timestamp: Date.UTC(2026, 10, 10, 10, 3),
					duration: 1500,
					ttft: 300,
				},
			},
		]);

		const { stats } = await parseSessionFile(file);
		expect(stats.map(row => [row.entryId, row.purpose ?? null, row.duration, row.ttft])).toEqual([
			["title-1", "title", 840, 210],
			["caption-1", "job-caption", null, null],
			["anonymous-1", "unknown", null, null],
			["turn-1", null, 1500, 300],
		]);
	});

	it("fills the purpose and timings of a row stored without them when its session is ingested again", async () => {
		const file = await writeSession("--tmp--model-usage-reingest", [
			modelUsage("title-1", 0, { purpose: "title", duration: 840, ttft: 210 }),
		]);
		const [parsed] = (await parseSessionFile(file)).stats;
		await initDb();
		// What a build that predates the purpose column stored for this entry.
		insertMessageStats([{ ...parsed, purpose: undefined, duration: null, ttft: null }]);
		expect(getRecentRequests(5)).toMatchObject([{ entryId: "title-1", purpose: null, duration: null, ttft: null }]);

		insertMessageStats([parsed]);
		expect(getRecentRequests(5)).toMatchObject([{ entryId: "title-1", purpose: "title", duration: 840, ttft: 210 }]);
	});

	it("re-reads sessions changed since model_usage entries exist to attribute rows stored without a purpose", async () => {
		await writeSession("--tmp--model-usage-recent", [modelUsage("recent-1", 0, { purpose: "title" })]);
		const old = await writeSession("--tmp--model-usage-old", [modelUsage("old-1", 1, { purpose: "title" })]);
		const longAgo = new Date("2026-01-01T00:00:00Z");
		await fs.utimes(old, longAgo, longAgo);
		await syncAllSessions({ workers: 1 });

		// A database ingested before rows kept their purpose.
		const db = await initDb();
		db.run("UPDATE messages SET purpose = NULL");
		db.run("DELETE FROM meta WHERE key = 'model_usage_purpose_v1'");
		closeDb();

		await syncAllSessions({ workers: 1 });
		const purposes = new Map(getRecentRequests(5).map(row => [row.entryId, row.purpose]));
		expect(purposes.get("recent-1")).toBe("title");
		// Last modified before sessions journaled model_usage: its cursor stays and the file is not read again.
		expect(purposes.get("old-1")).toBeNull();
	});

	it("returns the journaled reply or judgment answers as the output of a model_usage request", async () => {
		const answers = { relevant: 0.92, kind: ["bugfix", 0.71] };
		const file = await writeSession("--tmp--model-usage-payload", [
			modelUsage("title-1", 0, {
				purpose: "title",
				completion: { prompt: "fix the login", reply: "Fix Login Redirect" },
			}),
			modelUsage("judge-1", 1, {
				purpose: "judge",
				api: "typesafe",
				provider: "typesafe",
				model: "jev-latest",
				judgment: { state: "0f3a", answers },
			}),
		]);
		await initDb();
		insertMessageStats((await parseSessionFile(file)).stats);
		const outputs = new Map<string, unknown>();
		for (const row of getRecentRequests(5)) {
			const response = await handleApi(new Request(`http://stats.test/api/request/${row.id}`));
			outputs.set(row.entryId, ((await response.json()) as { output: unknown }).output);
		}

		expect(outputs.get("title-1")).toBe("Fix Login Redirect");
		expect(outputs.get("judge-1")).toEqual(answers);
	});
});
