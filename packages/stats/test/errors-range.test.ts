import { describe, expect, it } from "bun:test";
import { initDb, insertMessageStats } from "../src/db";
import { handleApi } from "../src/server";
import type { MessageStats } from "../src/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const HOUR_MS = 60 * 60 * 1000;

installStatsTestIsolation("@pi-stats-errors-range-");

function makeError(timestamp: number, entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/errors-range-session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "error",
		errorMessage: `failure ${entryId}`,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		agentType: "main",
	};
}

async function readMessages(response: Response): Promise<MessageStats[]> {
	expect(response.status).toBe(200);
	return response.json() as Promise<MessageStats[]>;
}

describe("Recent Errors range", () => {
	it("filters by the mapped range before returning the newest 50 errors", async () => {
		await initDb();
		const now = Date.now();
		const recentErrors = Array.from({ length: 50 }, (_, index) => makeError(now - index * 1000, `recent-${index}`));
		const oldError = makeError(now - 48 * HOUR_MS, "outside-24h");
		insertMessageStats([...recentErrors, oldError]);

		const dayErrors = await readMessages(
			await handleApi(new Request("http://stats.test/api/stats/errors?range=24h&limit=50")),
		);
		expect(dayErrors).toHaveLength(50);
		expect(dayErrors.map(error => error.entryId)).toEqual(recentErrors.map(error => error.entryId));
		expect(dayErrors.some(error => error.entryId === oldError.entryId)).toBe(false);

		const allErrors = await readMessages(
			await handleApi(new Request("http://stats.test/api/stats/errors?range=all&limit=51")),
		);
		expect(allErrors).toHaveLength(51);
		expect(allErrors.at(-1)?.entryId).toBe(oldError.entryId);

		const defaultErrors = await readMessages(
			await handleApi(new Request("http://stats.test/api/stats/errors?limit=51")),
		);
		expect(defaultErrors).toHaveLength(50);
		expect(defaultErrors.some(error => error.entryId === oldError.entryId)).toBe(false);

		const fallbackErrors = await readMessages(
			await handleApi(new Request("http://stats.test/api/stats/errors?range=unknown&limit=51")),
		);
		expect(fallbackErrors.map(error => error.entryId)).toEqual(defaultErrors.map(error => error.entryId));
	});
});
