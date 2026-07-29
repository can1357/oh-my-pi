import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import {
	createActivitySynthesisFacts,
	type GopkClipIngestionPolicy,
	ingestGopkClip,
	purgeExpiredRawClips,
	SqliteActivityLedger,
} from "../src";

const consent: ConsentRecord = {
	userId: "user-1",
	deviceId: "device-1",
	identityVerified: true,
	enabled: true,
	scope: "device",
	remoteStorageEnabled: false,
	policyVersion: "context-retention/v1",
};

const policy: GopkClipIngestionPolicy = {
	enabled: true,
	ocrEnabled: true,
	allowedApplicationIds: ["code"],
	deniedApplicationIds: ["password-manager"],
	maximumRawClipRetentionMs: 10 * 60_000,
};

function ingest(ledger: SqliteActivityLedger, overrides: Record<string, unknown> = {}) {
	return ingestGopkClip({
		capture: { userId: "user-1", deviceId: "device-1", sessionId: "session-1", projectId: "omp" },
		consent,
		policy,
		ingestedAt: "2026-07-13T14:06:00.000Z",
		ledger,
		analysis: {
			clipId: "clip-1",
			window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:05:00.000Z" },
			application: { id: "code", category: "editor" },
			redaction: { status: "redacted", completedAt: "2026-07-13T14:05:30.000Z" },
			redactedDigest: "Edited the activity journal adapter.",
			activityCategory: "coding",
			confidence: "high",
			confidenceReason: "Multiple redacted keyframes agreed on the active editor.",
			clipHash: "sha256:clip",
			keyframeHash: "sha256:keyframe",
			localPointer: "C:\\captures\\clip-1.manifest.json",
			rawClip: { localPointer: "C:\\captures\\clip-1.webm", expiresAt: "2026-07-13T14:10:00.000Z" },
			...overrides,
		},
	});
}

describe("gopk clip activity ingestion", () => {
	it("stores only redacted corroborating evidence and never exposes local media references to synthesis", () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const result = ingest(ledger);
		expect(result.status).toBe("stored");
		if (result.status === "rejected") throw new Error(result.reason);
		expect(result.evidence).toMatchObject({
			projectId: "omp",
			application: { id: "code", category: "editor" },
			strength: "corroborating",
			signal: "screen_active",
			confidence: "medium",
		});
		expect(ledger.list()).toHaveLength(1);

		const timeline = {
			window: result.evidence.window,
			segments: [
				{
					window: result.evidence.window,
					classification: "screen_corroboration" as const,
					confidence: result.evidence.confidence,
					confidenceReason: result.evidence.confidenceReason,
					activityCategories: [result.evidence.activityCategory],
					sources: [result.evidence.source],
					evidenceIds: [result.evidence.id],
				},
			],
			totals: { humanActiveEstimateMs: 0, agentRuntimeMs: 0, screenCorroborationMs: 300_000, unknownMs: 0 },
		};
		const serializedFacts = JSON.stringify(createActivitySynthesisFacts(timeline));
		expect(serializedFacts).not.toContain("C:\\captures");
		expect(serializedFacts).not.toContain("Edited the activity journal adapter");
		expect(result.evidence.ocrSnippet).toBeUndefined();
		ledger.close();
	});

	it("rejects raw capture while the explicit opt-in is disabled", () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const result = ingestGopkClip({
			capture: { userId: "user-1", deviceId: "device-1", sessionId: "session-1" },
			consent,
			policy: { ...policy, enabled: false },
			ingestedAt: "2026-07-13T14:06:00.000Z",
			ledger,
			analysis: {
				clipId: "disabled-clip",
				window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:05:00.000Z" },
				application: { id: "code", category: "editor" },
				redaction: { status: "unverified", completedAt: "2026-07-13T14:05:30.000Z" },
				activityCategory: "coding",
				confidence: "low",
				confidenceReason: "none",
				clipHash: "sha256:clip",
				localPointer: "C:\\captures\\disabled.manifest.json",
			},
		});
		expect(result).toMatchObject({ status: "rejected", reason: "gopk clip capture is disabled" });
		expect(ledger.list()).toEqual([]);
		ledger.close();
	});

	it("rejects derivatives whose redaction has not completed", () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const result = ingest(ledger, {
			redaction: { status: "unverified", completedAt: "2026-07-13T14:05:30.000Z" },
		});
		expect(result).toMatchObject({ status: "rejected", reason: "clip redaction was not completed" });
		expect(ledger.list()).toEqual([]);
		ledger.close();
	});

	it("rejects denylisted applications before persisting clip metadata", () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const result = ingest(ledger, { application: { id: "password-manager", category: "private" } });
		expect(result).toMatchObject({
			status: "rejected",
			reason: "application is denied by capture policy",
			rawClipToDelete: "C:\\captures\\clip-1.webm",
		});
		expect(ledger.list()).toEqual([]);
		ledger.close();
	});

	it("rejects OCR snippets longer than 280 characters", () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const result = ingest(ledger, { ocrSnippet: "x".repeat(281) });

		expect(result).toMatchObject({
			status: "rejected",
			reason: "OCR snippet must be a non-empty string of at most 280 characters",
		});
		expect(ledger.list()).toEqual([]);
		ledger.close();
	});

	it("deletes expired raw clips while retaining an auditable deletion receipt", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		ingest(ledger);
		const removed: string[] = [];
		const result = await purgeExpiredRawClips(
			ledger,
			{ remove: async localPointer => void removed.push(localPointer) },
			"2026-07-13T14:11:00.000Z",
		);
		expect(result).toEqual({ deletedEvidenceIds: ["gopk_clips:clip-1"], failures: [] });
		expect(removed).toEqual(["C:\\captures\\clip-1.webm"]);
		expect(ledger.list()[0]?.rawClip?.deletedAt).toBe("2026-07-13T14:11:00.000Z");
		ledger.close();
	});
});

describe("SqliteActivityLedger durability pragmas", () => {
	it("persists WAL mode so readers don't block on a writer's rollback journal", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-pragma-"));
		const ledgerPath = path.join(tmpDir, "test.sqlite");
		try {
			const ledger = new SqliteActivityLedger(ledgerPath);
			ledger.close();
			// WAL mode is a database-level property that persists across
			// connections; re-opening read-only proves the writer set it.
			const probe = new Database(ledgerPath, { readonly: true, strict: true });
			const row = probe.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
			probe.close();
			expect(row?.journal_mode.toLowerCase()).toBe("wal");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
