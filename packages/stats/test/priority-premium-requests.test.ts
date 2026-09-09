import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getOverallStats, getRecentRequests } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-priority-");

interface SessionLines {
	lines: Array<Record<string, unknown>>;
}

async function writeSession(folder: string, name: string, { lines }: SessionLines): Promise<string> {
	const dir = path.join(getSessionsDir(), folder);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, name);
	const text = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	await fs.writeFile(filePath, text);
	return filePath;
}

function assistantEntry(opts: {
	id: string;
	parentId?: string | null;
	provider: string;
	api?: string;
	premiumRequests?: number;
}): Record<string, unknown> {
	return {
		type: "message",
		id: opts.id,
		parentId: opts.parentId ?? null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: opts.api ?? "openai-responses",
			provider: opts.provider,
			model: "gpt-5.4",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				...(opts.premiumRequests !== undefined ? { premiumRequests: opts.premiumRequests } : {}),
			},
		},
	};
}

describe("priority service-tier premium-request backfill", () => {
	it("derives premium_requests from service_tier_change entries for providers that honor priority", async () => {
		await writeSession("--tmp--proj", "01.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s1", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc1", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "a1", provider: "openai" }),
				assistantEntry({ id: "a2", provider: "openai-codex" }),
				// Direct Anthropic always records api "anthropic-messages" — the
				// service-tier family is classified by api, not provider (Bedrock/
				// Vertex Claude belong to the anthropic knob too).
				assistantEntry({ id: "a3", provider: "anthropic", api: "anthropic-messages" }),
				{ type: "service_tier_change", id: "stc2", timestamp: new Date().toISOString(), serviceTier: null },
				assistantEntry({ id: "a4", provider: "openai" }),
			],
		});

		await syncAllSessions();

		const overall = await getOverallStats();
		expect(overall.totalRequests).toBe(4);
		expect(overall.totalPremiumRequests).toBe(3);
	});

	it("preserves an existing non-zero premiumRequests value (Copilot multiplier) even under priority tier", async () => {
		await writeSession("--tmp--proj", "02.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s2", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "b1", provider: "github-copilot", premiumRequests: 0.33 }),
			],
		});

		await syncAllSessions();

		const request = getRecentRequests(1)[0];
		expect(request?.usage.premiumRequests).toBeCloseTo(0.33, 6);
	});

	it("re-derives premium_requests on re-sync via UPSERT for sessions ingested before the fix", async () => {
		// Simulate the upgrade path: an older release already ingested a
		// priority OpenAI request with `premium_requests = 0` and persisted a
		// `file_offsets` row that says "fully ingested". On the next `initDb`
		// the new backfill sentinel is absent, so `file_offsets` is wiped and
		// the parser re-reads the session — this time deriving the priority
		// count from the recorded `service_tier_change` and upserting the row.
		const sessionFile = await writeSession("--tmp--proj", "03.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s3", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "c1", provider: "openai" }),
			],
		});

		// Bootstrap schema, then close so we can plant the stale-state fixtures
		// directly without going through a real parse.
		await syncAllSessions();
		closeDb();

		const sessionStats = await fs.stat(sessionFile);
		const raw = new Database(getStatsDbPath());
		raw.exec("DELETE FROM messages");
		raw.exec("DELETE FROM file_offsets");
		raw.exec("DELETE FROM meta WHERE key = 'premium_requests_priority_v1'");
		raw.prepare(
			`INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionFile,
			"c1",
			"/tmp/proj",
			"gpt-5.4",
			"openai",
			"openai-responses",
			Date.now(),
			1000,
			100,
			"stop",
			null,
			10,
			5,
			0,
			0,
			15,
			0,
			0,
			0,
			0,
			0,
			0,
		);
		raw.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
			sessionFile,
			sessionStats.size,
			sessionStats.mtimeMs,
		);
		raw.close();

		// Next sync triggers the priority backfill: clears `file_offsets`, the
		// parser re-derives `premium_requests = 1`, and the UPSERT updates the
		// stale row in place.
		await syncAllSessions();

		const request = getRecentRequests(1)[0];
		expect(request?.entryId).toBe("c1");
		expect(request?.usage.premiumRequests).toBe(1);
	});

	it("carries the active service tier across incremental parseSessionFile calls", async () => {
		// Session opens with priority, then a reply lands after we've already
		// advanced `fromOffset` past the tier-change entry. The parser must
		// replay the prefix and still attribute the reply as a premium request.
		const sessionFile = await writeSession("--tmp--proj", "04.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s4", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "d1", provider: "openai" }),
			],
		});

		// Locate the byte offset immediately past the `service_tier_change`
		// line so the second sync's `fromOffset` lands between the tier entry
		// and the assistant reply — the exact window where the regression hid.
		const bytes = await fs.readFile(sessionFile);
		const tierLineEnd = bytes.indexOf(0x0a, bytes.indexOf(Buffer.from("service_tier_change"))) + 1;
		expect(tierLineEnd).toBeGreaterThan(0);

		const second = await parseSessionFile(sessionFile, tierLineEnd);
		expect(second.stats).toHaveLength(1);
		expect(second.stats[0]?.entryId).toBe("d1");
		expect(second.stats[0]?.usage.premiumRequests).toBe(1);
	});
});
