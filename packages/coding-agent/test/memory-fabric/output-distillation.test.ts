import { describe, expect, it } from "bun:test";

import {
	applyNeverWorseGuard,
	boundRedactedOriginal,
	createEvidenceSink,
	type DistilledToolOutput,
	detectFormat,
	distill,
	distillGuarded,
	InMemoryEvidenceStore,
	REDACTION_VERSION,
	type RedactedEvidenceRecord,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/output-distillation";

const NOW = () => new Date("2026-01-01T00:00:00.000Z");

function distilled(overrides: Partial<DistilledToolOutput> = {}): DistilledToolOutput {
	return {
		format: "generic",
		summary: "s",
		criticalLines: [],
		warnings: [],
		errors: [],
		text: "ok",
		originalBytes: 2,
		distilledBytes: 2,
		originalTokens: 1,
		distilledTokens: 1,
		compressionRatio: 1,
		rawEvidenceId: "",
		reversible: false,
		redactionCount: 0,
		passthrough: false,
		...overrides,
	};
}

describe("detectFormat", () => {
	it("honours an explicit hint", () => {
		expect(detectFormat({ content: "", formatHint: "build" }, "anything")).toBe("build");
	});

	it("detects git diffs, git logs, compiler and test output", () => {
		expect(detectFormat({ content: "" }, "diff --git a/x b/x\n@@ -1 +1 @@")).toBe("git-diff");
		expect(detectFormat({ content: "" }, "commit 0123abc example")).toBe("git-log");
		expect(detectFormat({ content: "" }, "x.ts(1,1): error TS2304: nope")).toBe("compiler");
		expect(detectFormat({ content: "" }, "3 pass\n1 fail\nRan 4 tests")).toBe("test");
		expect(detectFormat({ content: "" }, "just some text")).toBe("generic");
	});
});

describe("distill", () => {
	it("passes small inputs through untouched", () => {
		const result = distill({ content: "hello" }, { now: NOW });
		expect(result.passthrough).toBe(true);
		expect(result.text).toBe("hello");
		expect(result.reversible).toBe(false);
	});

	it("redacts before archiving evidence", () => {
		const store = new InMemoryEvidenceStore();
		// Built at runtime so the repo never contains a token-shaped literal.
		const secret = `token ghp_${"a".repeat(36)} oops`;
		const result = distill(
			{ content: secret, projectId: "p1" },
			{ evidenceSink: createEvidenceSink(store), now: NOW },
		);
		expect(store.size).toBe(1);
		const record = store.get(result.rawEvidenceId);
		expect(record?.content).not.toContain("******");
		expect(record?.content).toContain("[REDACTED:GITHUB_TOKEN]");
		expect(record?.redactionVersion).toBe(REDACTION_VERSION);
		expect(record?.projectId).toBe("p1");
		expect(result.redactionCount).toBe(1);
	});

	it("collapses passing test lines but keeps failures and the summary", () => {
		const lines = [
			...Array.from({ length: 30 }, (_, i) => `✓ suite > case ${i} passes`),
			"✗ suite > broken case fails",
			"    at file.ts:10",
			"2 pass",
			"1 fail",
		];
		const result = distill({ content: lines.join("\n"), formatHint: "test" }, { now: NOW });
		expect(result.passthrough).toBe(false);
		expect(result.text).not.toContain("case 3 passes");
		expect(result.text).toContain("broken case fails");
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.compressionRatio).toBeLessThan(1);
	});

	it("keeps only diagnostics for compiler output", () => {
		const lines = [
			...Array.from({ length: 60 }, (_, i) => `checking module ${i}`),
			"src/a.ts(3,7): error TS2304: Cannot find name 'x'.",
			"Found 1 error.",
		];
		const result = distill({ content: lines.join("\n"), formatHint: "compiler" }, { now: NOW });
		expect(result.summary).toBe("Found 1 error.");
		expect(result.errors).toHaveLength(1);
		expect(result.text).not.toContain("checking module 5");
	});

	it("elides the middle of long generic output but keeps error lines", () => {
		const lines = [
			...Array.from({ length: 50 }, (_, i) => `step ${i}`),
			"error: something exploded",
			...Array.from({ length: 50 }, (_, i) => `tail ${i}`),
		];
		const result = distill({ content: lines.join("\n") }, { now: NOW });
		expect(result.text).toContain("lines elided");
		expect(result.text).toContain("something exploded");
	});

	it("fails open to a passthrough excerpt when the redactor throws", () => {
		const result = distill(
			{ content: "x".repeat(500) },
			{
				now: NOW,
				redactor: () => {
					throw new Error("boom");
				},
			},
		);
		expect(result.text).toContain("[REDACTION_FAILED]");
		expect(result.text).not.toContain("xxx");
	});

	it("never fails the tool result when the evidence sink throws", () => {
		const result = distill(
			{ content: "y".repeat(500) },
			{
				now: NOW,
				evidenceSink: () => {
					throw new Error("storage down");
				},
			},
		);
		expect(result.rawEvidenceId.startsWith("ev_")).toBe(true);
	});
});

describe("createEvidenceSink", () => {
	it("reports async store failures via onError without throwing", async () => {
		const errors: unknown[] = [];
		const sink = createEvidenceSink({ put: () => Promise.reject(new Error("db down")) }, e => errors.push(e));
		sink({} as RedactedEvidenceRecord);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(errors).toHaveLength(1);
	});
});

describe("boundRedactedOriginal", () => {
	it("returns short input unchanged", () => {
		expect(boundRedactedOriginal("a\nb")).toBe("a\nb");
	});

	it("re-inserts failure lines into the bounded excerpt", () => {
		const lines = [
			...Array.from({ length: 45 }, (_, i) => `head ${i}`),
			"error: kept",
			...Array.from({ length: 30 }, (_, i) => `tail ${i}`),
		];
		const bounded = boundRedactedOriginal(lines.join("\n"), 10, 5);
		expect(bounded).toContain("error: kept");
		expect(bounded).toContain("lines elided");
	});
});

describe("applyNeverWorseGuard", () => {
	it("keeps the distilled view when it is smaller and safe", () => {
		const result = applyNeverWorseGuard({ distilled: distilled(), redactedOriginal: "all good ".repeat(50) });
		expect(result.choice).toBe("distilled");
		expect(result.failureSignalInOriginal).toBe(false);
	});

	it("falls back when the distilled view dropped the failure signal", () => {
		const original = ["error: real failure", ...Array.from({ length: 10 }, () => "noise")].join("\n");
		const result = applyNeverWorseGuard({
			distilled: distilled({ text: "everything looks tidy" }),
			redactedOriginal: original,
		});
		expect(result.choice).toBe("bounded-original");
		expect(result.text).toContain("error: real failure");
		expect(result.failureSignalPreserved).toBe(false);
	});

	it("treats a non-zero exit code as a failure signal", () => {
		const result = applyNeverWorseGuard({
			distilled: distilled({ text: "clean" }),
			redactedOriginal: "no keywords here",
			exitCode: 2,
		});
		expect(result.choice).toBe("bounded-original");
	});

	it("falls back when the distilled view is larger than the bounded original", () => {
		const result = applyNeverWorseGuard({
			distilled: distilled({ text: "z".repeat(400), distilledTokens: 100 }),
			redactedOriginal: "short",
		});
		expect(result.choice).toBe("bounded-original");
		expect(result.reason).toContain("never-worse size guard");
	});

	it("emits telemetry and survives a throwing sink", () => {
		const seen: string[] = [];
		const result = applyNeverWorseGuard(
			{ distilled: distilled(), redactedOriginal: "fine" },
			{
				telemetrySink: t => {
					seen.push(t.choice);
					throw new Error("sink boom");
				},
			},
		);
		expect(result.choice).toBe("distilled");
		expect(seen).toEqual(["distilled"]);
	});

	it("fails open when the estimator throws", () => {
		const result = applyNeverWorseGuard(
			{ distilled: distilled({ text: "kept" }), redactedOriginal: "x" },
			{
				estimateTokens: () => {
					throw new Error("boom");
				},
			},
		);
		expect(result.choice).toBe("distilled");
		expect(result.text).toBe("kept");
		expect(result.reason).toBe("guard-error-fail-open");
	});
});

describe("distillGuarded", () => {
	it("compares against exactly what was archived (no double redaction)", () => {
		const store = new InMemoryEvidenceStore();
		const failing = [...Array.from({ length: 120 }, (_, i) => `✓ ok ${i}`), "✗ boom fails", "1 fail"].join("\n");
		const { distilled: d, guarded } = distillGuarded(
			{ content: failing, formatHint: "test", exitCode: 1 },
			{ distill: { evidenceSink: createEvidenceSink(store), now: NOW } },
		);
		expect(store.size).toBe(1);
		expect(d.errors.length).toBeGreaterThan(0);
		expect(guarded.failureSignalInOriginal).toBe(true);
		expect(guarded.failureSignalPreserved).toBe(true);
		expect(guarded.choice).toBe("distilled");
	});

	it("degrades to a safe no-op when archiving is disabled upstream", () => {
		const { guarded } = distillGuarded({ content: "tiny" }, { distill: { now: NOW } });
		expect(guarded.text).toBe("tiny");
	});
});
