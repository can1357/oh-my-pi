import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-error-display-");

describe("failed request error text", () => {
	it("keeps the shown text beside the provider's text through ingest", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--error-display");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		const shown = "HTTP 400 from http://127.0.0.1:11434/api/chat\nunknown model\nraw-http-request=/tmp/omp/1.json";
		await Bun.write(
			file,
			`${JSON.stringify({
				type: "message",
				id: "failed-1",
				parentId: null,
				timestamp: "2026-11-03T10:00:00.000Z",
				message: {
					role: "assistant",
					content: [],
					api: "ollama-chat",
					provider: "ollama",
					model: "llama3",
					stopReason: "error",
					errorMessage: "HTTP 400\nunknown model",
					errorDisplayMessage: shown,
					usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
					timestamp: 1,
				},
			})}\n`,
		);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		// Grouping and classification read the provider's text; the panels show the diagnostic.
		expect(getRecentRequests(1)[0]).toMatchObject({
			entryId: "failed-1",
			errorMessage: "HTTP 400\nunknown model",
			errorDisplayMessage: shown,
		});
	});
});
