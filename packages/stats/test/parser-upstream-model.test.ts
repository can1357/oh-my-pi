import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRecentRequests, getStatsByModel, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-upstream-model-");

describe("parser upstreamModel attribution", () => {
	it("attributes message stats and user links to upstreamModel when present", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--upstream-model");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");

		const userEntry = {
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-09-03T10:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "Fix this bug" }],
				timestamp: 1788412800000,
			},
		};

		const assistantEntry = {
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: "2026-09-03T10:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Fixed." }],
				api: "openai-completions",
				provider: "openrouter",
				model: "openrouter/auto",
				upstreamModel: "anthropic/claude-sonnet-4.5",
				upstreamProvider: "Anthropic",
				stopReason: "stop",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 10,
					cacheWrite: 0,
					totalTokens: 25,
				},
				timestamp: 1788412801000,
			},
		};

		await Bun.write(file, `${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`);

		const result = await parseSessionFile(file);

		expect(result.stats).toHaveLength(1);
		expect(result.stats[0].model).toBe("anthropic/claude-sonnet-4.5");
		expect(result.stats[0].provider).toBe("Anthropic");
		expect(result.userLinks).toHaveLength(1);
		expect(result.userLinks[0]).toMatchObject({
			sessionFile: file,
			entryId: "user-1",
			model: "anthropic/claude-sonnet-4.5",
			provider: "Anthropic",
		});

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		const catalogCost = getBundledModel("openrouter", "anthropic/claude-sonnet-4.5").cost;
		const request = getRecentRequests()[0];
		if (!request) throw new Error("Expected the routed request to be stored");
		expect(request).toMatchObject({
			model: "anthropic/claude-sonnet-4.5",
			provider: "Anthropic",
		});
		expect(request.usage.cost.cacheRead).toBeCloseTo((catalogCost.cacheRead * 10) / 1_000_000, 12);
		expect(request.usage.cost.total).toBeCloseTo(
			(catalogCost.input * 10 + catalogCost.output * 5 + catalogCost.cacheRead * 10) / 1_000_000,
			12,
		);
		expect(getStatsByModel()).toMatchObject([{ model: "anthropic/claude-sonnet-4.5", provider: "Anthropic" }]);
	});

	it("falls back to configured model and provider when upstreamModel is absent", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--standard-model");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");

		const assistantEntry = {
			type: "message",
			id: "assistant-2",
			parentId: "user-2",
			timestamp: "2026-09-03T10:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				api: "openai-completions",
				provider: "openrouter",
				model: "openrouter/auto",
				stopReason: "stop",
				usage: {
					input: 5,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 7,
					cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
				timestamp: 1788412801000,
			},
		};

		await Bun.write(file, `${JSON.stringify(assistantEntry)}\n`);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);
		expect(result.stats[0].model).toBe("openrouter/auto");
		expect(result.stats[0].provider).toBe("openrouter");
	});
});
