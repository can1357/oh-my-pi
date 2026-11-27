import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { getOverallStats, getStatsByProvider, refreshRollups } from "@oh-my-pi/omp-stats/rollup";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-ai-credits-");

const HOUR = 60 * 60 * 1000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR;

function message(
	entryId: string,
	provider: string,
	usage: Partial<MessageStats["usage"]> = {},
	timestamp = BASE + 10 * 60_000,
): MessageStats {
	return {
		sessionFile: `/tmp/${entryId}.jsonl`,
		entryId,
		folder: "/work/a",
		model: "model-x",
		provider,
		api: "openai-responses",
		timestamp,
		duration: 2000,
		ttft: 300,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 100,
			output: 40,
			cacheRead: 60,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
			...usage,
		},
		agentType: "main",
	};
}

async function writeTranscript(
	fileName: string,
	sessionId: string,
	parentSession: string | undefined,
	text: string,
	withAiu: boolean,
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--work--a");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const timestamp = new Date(BASE + 60 * 60_000).toISOString();
	const entries = [
		{
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd: "/work/a",
			...(parentSession ? { parentSession } : {}),
		},
		{
			type: "message",
			id: "copilot-entry",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-4.1",
				responseId: "copilot-response",
				usage: {
					input: 100,
					output: 40,
					cacheRead: 60,
					cacheWrite: 0,
					totalTokens: 200,
					...(withAiu ? { aiu: { nano: 8_000_000 } } : {}),
				},
				stopReason: "stop",
				timestamp: Date.parse(timestamp),
				duration: 2000,
				ttft: 300,
			},
		},
	];
	await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return sessionFile;
}

describe("AI credits in stats", () => {
	it("reports unknown, not zero, until a request carries a billing frame", async () => {
		await initDb();
		insertMessageStats([message("a", "openai-codex"), message("b", "github-copilot")]);
		expect(getOverallStats(null).totalAiuNano).toBeNull();

		insertMessageStats([message("c", "github-copilot", { aiu: { nano: 436_590_000 } }, BASE + 20 * 60_000)]);
		insertMessageStats([message("d", "github-copilot", { aiu: { nano: 6_790_000 } }, BASE + 30 * 60_000)]);
		const live = getOverallStats(null).totalAiuNano;
		expect(live).toBe(443_380_000);

		// The rolled aggregate must agree with the live one, per provider too.
		await refreshRollups();
		expect(getOverallStats(null).totalAiuNano).toBe(live);
		const byProvider = new Map(getStatsByProvider(null).map(p => [p.provider, p.totalAiuNano]));
		expect(byProvider.get("github-copilot")).toBe(443_380_000);
		expect(byProvider.get("openai-codex")).toBeNull();
	});

	it("keeps legacy premium requests and credits as independent meters across a re-parse", async () => {
		await initDb();
		insertMessageStats([
			message("a", "github-copilot", { premiumRequests: 1 }),
			message("x", "openai-codex", { premiumRequests: 2 }),
		]);
		expect(getOverallStats(null).totalPremiumRequests).toBe(3);

		// Same transcript row re-parsed after the billing frame was recorded: the credits arrive, the stored count stays.
		insertMessageStats([message("a", "github-copilot", { premiumRequests: 1, aiu: { nano: 5_000_000 } })]);
		expect(getOverallStats(null)).toMatchObject({ totalPremiumRequests: 3, totalAiuNano: 5_000_000 });

		// A later re-parse of a build that never read the frame must not erase the stored credits.
		insertMessageStats([message("a", "github-copilot", { premiumRequests: 1 })]);
		expect(getOverallStats(null)).toMatchObject({ totalPremiumRequests: 3, totalAiuNano: 5_000_000 });
	});

	it("treats a malformed charge as unknown and keeps the premium estimate", async () => {
		await initDb();
		const malformed = [Number.NaN, -1, "12" as unknown as number];
		insertMessageStats(
			malformed.map((nano, index) =>
				message(
					`bad${index}`,
					"github-copilot",
					{ premiumRequests: 1, aiu: { nano } },
					BASE + (40 + index) * 60_000,
				),
			),
		);
		expect(getOverallStats(null)).toMatchObject({ totalAiuNano: null, totalPremiumRequests: 3 });
	});

	it("credits a turn to the stats when the fork that copied it is ingested before its parent", async () => {
		await initDb();
		const at = BASE + 50 * 60_000;
		// A /tan fork copies the turn with its billing stripped and is ingested first, so it owns the identity.
		insertMessageStats([{ ...message("shared", "github-copilot", {}, at), sessionFile: "/tmp/fork.jsonl" }]);
		expect(getOverallStats(null).totalAiuNano).toBeNull();

		// The parent's copy carries the charge; it is skipped as a duplicate but its credits must survive.
		insertMessageStats([
			{
				...message("shared", "github-copilot", { aiu: { nano: 8_000_000 } }, at),
				sessionFile: "/tmp/parent.jsonl",
			},
		]);
		const live = getOverallStats(null);
		expect(live).toMatchObject({ totalRequests: 1, totalAiuNano: 8_000_000, totalPremiumRequests: 0 });

		// A re-parse must not add the charge twice, and the rolled aggregate must agree.
		insertMessageStats([
			{
				...message("shared", "github-copilot", { aiu: { nano: 8_000_000 } }, at),
				sessionFile: "/tmp/parent.jsonl",
			},
		]);
		await refreshRollups();
		expect(getOverallStats(null)).toMatchObject({ totalRequests: 1, totalAiuNano: 8_000_000 });
	});

	it("keeps a copied charge through a transcript rewrite and reports charge-only sync changes", async () => {
		await initDb();
		const parentFile = await writeTranscript("parent.jsonl", "parent-session", undefined, "copied turn", true);
		const forkFile = await writeTranscript("fork.jsonl", "fork-session", parentFile, "copied turn", false);
		await syncAllSessions({ files: [forkFile], workers: 1 });
		expect(getOverallStats(null).totalAiuNano).toBeNull();

		const reportedChanges: number[] = [];
		await syncAllSessions({
			files: [parentFile],
			workers: 1,
			onProgress: event => reportedChanges.push(event.changes),
		});
		expect(reportedChanges.at(-1)).toBeGreaterThan(0);
		expect(getOverallStats(null)).toMatchObject({ totalRequests: 1, totalAiuNano: 8_000_000 });
		expect(getRecentRequests(10).find(row => row.entryId === "copilot-entry")?.sessionFile).toBe(forkFile);

		await writeTranscript("fork.jsonl", "fork-session", parentFile, "rewritten copied turn", false);
		await syncAllSessions({ files: [forkFile], workers: 1 });
		expect(getOverallStats(null)).toMatchObject({ totalRequests: 1, totalAiuNano: 8_000_000 });
		await refreshRollups();
		expect(getOverallStats(null)).toMatchObject({ totalRequests: 1, totalAiuNano: 8_000_000 });
	});
});
