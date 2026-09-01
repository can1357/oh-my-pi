import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-model-usage-");

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
});
