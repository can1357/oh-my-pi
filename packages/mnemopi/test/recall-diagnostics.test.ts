import { describe, expect, it } from "bun:test";
import * as Beam from "@oh-my-pi/pi-mnemopi/core/beam";
import {
	explainRecallDiagnostics,
	getDiagnostics,
	getRecallDiagnostics,
	RECALL_TIERS,
	RecallDiagnostics,
	resetRecallDiagnostics,
} from "@oh-my-pi/pi-mnemopi/core/recall-diagnostics";
import * as Db from "@oh-my-pi/pi-mnemopi/db";

describe("recall diagnostics counters", () => {
	it("starts with canonical tiers and zeroed JSON-serializable snapshot", () => {
		expect(RECALL_TIERS).toEqual(["wm_fts", "wm_vec", "wm_fallback", "em_fts", "em_vec", "em_fallback"]);
		const snapshot = new RecallDiagnostics().snapshot();
		expect(snapshot.totals.calls).toBe(0);
		expect(snapshot.totals.wm_fallback_rate).toBe(0);
		expect(snapshot.totals.em_fallback_rate).toBe(0);
		for (const tier of RECALL_TIERS) {
			expect(snapshot.by_tier[tier]).toEqual({ calls_with_hits: 0, total_hits: 0 });
		}
		expect(JSON.parse(JSON.stringify(snapshot)).totals.calls).toBe(0);
	});

	it("records tier hits, fallback usage, calls, and rates", () => {
		const diag = new RecallDiagnostics();
		diag.recordTierHits("wm_fts", 5);
		diag.recordTierHits("wm_fts", 3);
		diag.recordTierHits("wm_fts", 0);
		diag.recordFallbackUsed({ wm: true });
		diag.recordFallbackUsed({ em: true });
		diag.recordFallbackUsed({ wm: true, em: true });
		diag.recordCall();
		diag.recordCall();
		diag.recordCall({ trulyEmpty: true });

		const snapshot = diag.snapshot();
		expect(snapshot.by_tier.wm_fts.total_hits).toBe(8);
		expect(snapshot.by_tier.wm_fts.calls_with_hits).toBe(2);
		expect(snapshot.totals.calls_using_wm_fallback).toBe(2);
		expect(snapshot.totals.calls_using_em_fallback).toBe(2);
		expect(snapshot.totals.calls).toBe(3);
		expect(snapshot.totals.calls_truly_empty).toBe(1);
		expect(diag.fallbackRate().wm).toBeCloseTo(2 / 3);
		expect(diag.fallbackRate().em).toBeCloseTo(2 / 3);
	});

	it("rejects invalid records and clamps race-shaped fallback rates", () => {
		const diag = new RecallDiagnostics();
		expect(() => diag.recordTierHits("bogus", 1)).toThrow("unknown recall tier");
		expect(() => diag.recordTierHits("wm_fts", -1)).toThrow("hit_count must be >= 0");
		for (let i = 0; i < 5; i++) diag.recordFallbackUsed({ wm: true });
		diag.recordCall();
		expect(diag.fallbackRate().wm).toBe(1);
		expect(diag.snapshot().totals.wm_fallback_rate).toBe(1);
	});

	it("resets class and singleton state", () => {
		const diag = new RecallDiagnostics();
		diag.recordTierHits("em_vec", 2);
		diag.recordFallbackUsed({ em: true });
		diag.recordCall();
		diag.reset();
		expect(diag.snapshot().totals.calls).toBe(0);
		expect(diag.snapshot().by_tier.em_vec.total_hits).toBe(0);

		resetRecallDiagnostics();
		const first = getDiagnostics();
		const second = getDiagnostics();
		expect(first).toBe(second);
		first.recordCall();
		expect(getRecallDiagnostics().totals.calls).toBe(1);
		resetRecallDiagnostics();
		expect(getRecallDiagnostics().totals.calls).toBe(0);
	});

	it("explains whether signal came from primary paths or fallback", () => {
		const diag = new RecallDiagnostics();
		diag.recordTierHits("wm_fts", 2);
		diag.recordTierHits("wm_fallback", 1);
		diag.recordFallbackUsed({ wm: true });
		diag.recordCall({ trulyEmpty: false });
		const lines = explainRecallDiagnostics(diag.snapshot());
		expect(lines.some(line => line.includes("WM fallback used on 1/1 calls"))).toBe(true);
		expect(lines.some(line => line.includes("wm_fts: 2 kept hits"))).toBe(true);
	});

	it("supports a schema-backed smoke path without invoking full recall", () => {
		const db = Db.openDatabase(":memory:", { create: true, readwrite: true });
		try {
			Beam.initBeam(db);
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["wm-1", "Alice prefers Vim editor", "pref", now, "s1", 0.7, "unknown", now],
			);
			const row = db.query("SELECT id, content FROM working_memory WHERE id = ?").get("wm-1") as {
				id: string;
				content: string;
			} | null;
			expect(row).toEqual({ id: "wm-1", content: "Alice prefers Vim editor" });

			const diag = new RecallDiagnostics();
			diag.recordTierHits("wm_fts", row === null ? 0 : 1);
			diag.recordCall({ trulyEmpty: row === null });
			expect(diag.snapshot().by_tier.wm_fts.total_hits).toBe(1);
		} finally {
			Db.closeQuietly(db);
		}
	});
});
