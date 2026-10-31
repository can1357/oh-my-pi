import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-retry-after-");

const USAGE = {
	input: 10,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failedTurn(id: string, failure: { errorMessage: string; errorRetryAfterMs?: number }): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-10-31T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			content: [],
			usage: USAGE,
			stopReason: "error",
			timestamp: Date.parse("2026-10-31T00:00:00.000Z") + Number(id.slice(1)),
			...failure,
		},
	});
}

async function ingest(lines: string[]): Promise<void> {
	const dir = path.join(getSessionsDir(), "--tmp--retry-after");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, `${lines.join("\n")}\n`);
	await initDb();
	insertMessageStats((await parseSessionFile(file)).stats);
}

function requestFor(entryId: string) {
	const row = getRecentRequests(10).find(request => request.entryId === entryId);
	if (!row) throw new Error(`Expected an ingested request for ${entryId}`);
	return row;
}

describe("the server's retry wait in stats.db", () => {
	it("stores the wait in its own column and keeps the error text raw", async () => {
		await ingest([failedTurn("e1", { errorMessage: "429 rate_limit_error", errorRetryAfterMs: 30_000 })]);

		// The Errors view groups on `error_message`; a wait written into it would
		// split one failure into a group per wait.
		expect(requestFor("e1")).toMatchObject({ errorMessage: "429 rate_limit_error", errorRetryAfterMs: 30_000 });
	});

	it("stores no wait for a turn that stated none, even when its old text names one", async () => {
		await ingest([failedTurn("e2", { errorMessage: "429 rate_limit_error retry-after-ms=9000" })]);

		const row = requestFor("e2");
		expect(row.errorRetryAfterMs).toBeNull();
		expect(row.errorMessage).toBe("429 rate_limit_error retry-after-ms=9000");
	});

	it("fills the wait when a re-parse re-ingests a row stored without it", async () => {
		await ingest([failedTurn("e3", { errorMessage: "429 rate_limit_error" })]);
		expect(requestFor("e3").errorRetryAfterMs).toBeNull();

		await ingest([failedTurn("e3", { errorMessage: "429 rate_limit_error", errorRetryAfterMs: 45_000 })]);
		expect(requestFor("e3").errorRetryAfterMs).toBe(45_000);
	});

	it("fills the wait from a model_usage entry", async () => {
		await ingest([
			JSON.stringify({
				type: "model_usage",
				id: "u1",
				parentId: null,
				timestamp: "2026-10-31T00:00:01.000Z",
				purpose: "judge",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				usage: USAGE,
				stopReason: "error",
				errorMessage: "429 rate_limit_error",
				errorRetryAfterMs: 12_000,
			}),
		]);

		expect(requestFor("u1")).toMatchObject({ errorMessage: "429 rate_limit_error", errorRetryAfterMs: 12_000 });
	});
});
