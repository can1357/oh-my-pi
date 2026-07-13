import { describe, expect, it } from "bun:test";
import { importJournalJsonl, ingestPrimaryActivity, SqliteActivityLedger } from "../src";

describe("local journal source import", () => {
	it("imports timestamped OMP journal activity without retaining message content", () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const result = importJournalJsonl({
			source: "omp",
			sessionId: "omp-session",
			projectId: "omp",
			ledger,
			jsonl: [
				'{"type":"session","id":"header","timestamp":"2026-07-13T14:00:00.000Z","cwd":"C:/repo"}',
				'{"type":"message","id":"a","timestamp":"2026-07-13T14:00:00.000Z","message":{"content":"PRIVATE_PROMPT"}}',
				'{"type":"message","id":"b","timestamp":"2026-07-13T14:00:00.000Z","message":{"content":"PRIVATE_RESPONSE"}}',
				'{"type":"message","id":"c","timestamp":"2026-07-13T14:10:00.000Z","message":{"content":"PRIVATE_TOOL_OUTPUT"}}',
			].join("\n"),
		});
		expect(result).toEqual({
			storedEvidenceIds: ["omp:omp-session:a", "omp:omp-session:b", "omp:omp-session:c"],
			duplicateEvidenceIds: [],
			ignoredLineNumbers: [1],
		});
		const evidence = ledger.list();
		expect(evidence).toHaveLength(3);
		expect(evidence.every(item => item.signal === "agent_runtime" && item.strength === "primary")).toBe(true);
		expect(evidence.every(item => Date.parse(item.window.endedAt) > Date.parse(item.window.startedAt))).toBe(true);
		expect(JSON.stringify(evidence)).not.toContain("PRIVATE_");
		ledger.close();
	});

	it("normalizes Codex and Claude Code journal events alongside deterministic Git evidence", () => {
		const ledger = new SqliteActivityLedger(":memory:");
		for (const [source, type] of [
			["codex", "event_msg"],
			["claude_code", "assistant"],
		] as const) {
			const result = importJournalJsonl({
				source,
				sessionId: `${source}-session`,
				ledger,
				jsonl: `{"type":"${type}","id":"event","timestamp":"2026-07-13T14:00:00.000Z","payload":"ignored"}`,
			});
			expect(result.storedEvidenceIds).toEqual([`${source}:${source}-session:event`]);
		}
		expect(
			ingestPrimaryActivity(ledger, {
				id: "git:commit",
				source: "git",
				sourceEventId: "commit",
				window: { startedAt: "2026-07-13T14:05:00.000Z", endedAt: "2026-07-13T14:06:00.000Z" },
				recordedAt: "2026-07-13T14:06:00.000Z",
				activityCategory: "coding",
				confidenceReason: "Local commit metadata.",
				evidenceRef: { id: "abc123", kind: "commit" },
			}),
		).toBe(true);
		expect(ledger.list().find(item => item.id === "git:commit")).toMatchObject({ signal: "human_active" });
		ledger.close();
	});
});
