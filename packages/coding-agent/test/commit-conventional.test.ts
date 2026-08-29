import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CommitInferenceCache, computeCommitCacheKey } from "../src/commit/conventional/cache";
import { type ConventionalGenerationConfig, conventionalGenerationConfig } from "../src/commit/conventional/config";
import {
	ConventionalFileDiff,
	classifyDiffWhitespace,
	parsePromptDiff,
	reconstructPromptDiff,
	scrubDiffForPrompt,
} from "../src/commit/conventional/diff";
import { generateConventionalCommit } from "../src/commit/conventional/generate";
import type {
	CommitInference,
	CommitInferenceRequest,
	CommitInferenceResponse,
} from "../src/commit/conventional/inference";
import { buildFileBatches } from "../src/commit/conventional/map-reduce";
import {
	fallbackSummary,
	parseConventionalAnalysisMarkdown,
	parseSummaryMarkdown,
} from "../src/commit/conventional/markdown";
import { normalizeSummaryVerb } from "../src/commit/conventional/normalization";
import {
	extractComponentsFromPath,
	extractPathFromRename,
	extractScopeCandidates,
} from "../src/commit/conventional/scope";
import { repairSummaryTense, validateSummaryQuality } from "../src/commit/conventional/validation";

const DEFAULT_CONFIG = conventionalGenerationConfig({
	mapReduceEnabled: true,
	mapReduceThreshold: 5_000,
	mapBatchTokenBudget: 16_000,
	cacheEnabled: true,
	cacheTtlDays: 14,
	changelogMaxDiffChars: 120_000,
});

const SIMPLE_DIFF = `diff --git a/src/parser.ts b/src/parser.ts
index 123..456 100644
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -1,2 +1,2 @@
-return oldValue;
+return newValue;`;

class QueueInference implements CommitInference {
	readonly operations: string[] = [];
	readonly #responses: string[];

	constructor(responses: string[]) {
		this.#responses = [...responses];
	}

	async complete<T>(request: CommitInferenceRequest, parse: (response: CommitInferenceResponse) => T): Promise<T> {
		this.operations.push(request.operation);
		const text = this.#responses.shift();
		if (text === undefined) throw new Error(`No response queued for ${request.operation}`);
		return parse({ text, stopReason: "stop" });
	}
}

function config(overrides: Partial<ConventionalGenerationConfig> = {}): ConventionalGenerationConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

describe("llm-git scope parity", () => {
	test("preserves compact rename suffixes and extracts meaningful components", () => {
		expect(extractPathFromRename("lib/{old => new}/file.rs")).toBe("lib/new/file.rs");
		expect(extractPathFromRename("old/file.rs => new/file.rs")).toBe("new/file.rs");
		expect(extractComponentsFromPath("internal/config/parser/json.go")).toEqual(["config", "config/parser"]);
		expect(extractComponentsFromPath("lib/.git/config")).toEqual(["config"]);
	});

	test("uses the same dominant and cross-cutting scope thresholds", () => {
		const dominant = extractScopeCandidates("90\t10\tpackages/core/a.ts\n5\t5\tpackages/ui/b.ts\n", DEFAULT_CONFIG);
		expect(dominant).toEqual({
			scopeCandidates: "core (91%, moderate confidence)",
			isWide: false,
		});
		const wide = extractScopeCandidates(
			"10\t0\tpackages/core/a.ts\n10\t0\tpackages/ui/b.ts\n10\t0\tpackages/api/c.ts\n",
			DEFAULT_CONFIG,
		);
		expect(wide).toEqual({ scopeCandidates: "(none - multi-component change)", isWide: true });
	});
});

describe("llm-git diff parity", () => {
	test("round-trips multi-hunk diffs and preserves status counts", () => {
		const diff = `diff --git a/src/lib.rs b/src/lib.rs
index 111..222 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,2 +1,2 @@
-old one
+new one
---old marker
+++new marker
 context
@@ -20,2 +20,2 @@
-old two
+new two
 context`;
		const files = parsePromptDiff(diff);
		expect(reconstructPromptDiff(files)).toBe(diff);
		expect(files[0]).toMatchObject({ filename: "src/lib.rs", additions: 2, deletions: 2, status: "modified" });
	});

	test("classifies whitespace-only files before inference", () => {
		const whitespace = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-const x = 1;
+const  x = 1;`;
		expect(classifyDiffWhitespace(whitespace)).toEqual({
			whitespaceOnlyFiles: ["a.ts"],
			hasSubstantive: false,
			allWhitespace: true,
		});
	});

	test("collapses blob lines and respects UTF-8 file caps", () => {
		const scrubbed = scrubDiffForPrompt(
			`diff --git a/blob.ts b/blob.ts\n@@ -1 +1 @@\n-${"a".repeat(700)}\n+${"b".repeat(700)}`,
		);
		expect(scrubbed).toContain("[..omitted 557B..]");
		expect(Buffer.byteLength(scrubbed)).toBeLessThan(1_000);
	});

	test("batches files with both token and byte ceilings", () => {
		const files = [
			new ConventionalFileDiff("a.rs", "", "a".repeat(16)),
			new ConventionalFileDiff("b.rs", "", "b".repeat(16)),
			new ConventionalFileDiff("c.rs", "", "c".repeat(16)),
		];
		expect(buildFileBatches(files, 10)).toEqual([[0, 1], [2]]);
	});
});

describe("llm-git markdown and validation parity", () => {
	test("parses canonical, lenient, and aliased analysis headings", () => {
		const canonical = parseConventionalAnalysisMarkdown(
			"# feat(api): added authentication endpoint\n\n- Added POST /auth/login endpoint\n\nFixes: #123",
		);
		expect(canonical).toMatchObject({
			type: "feat",
			scope: "api",
			summary: "added authentication endpoint",
			issueRefs: ["#123"],
		});
		expect(canonical.details.map(detail => detail.text)).toEqual(["Added POST /auth/login endpoint."]);
		expect(parseConventionalAnalysisMarkdown("# ui: improved navigation").type).toBe("ux");
		expect(parseConventionalAnalysisMarkdown("# wibble: tweaked knobs").type).toBe("chore");
		expect(
			parseConventionalAnalysisMarkdown(
				'Result: {"type":"fix","scope":null,"summary":"corrected parser","details":[],"issue_refs":[]}',
			).summary,
		).toBe("corrected parser");
	});

	test("parses every supported summary wrapper", () => {
		for (const text of [
			"<summary>Added JWT auth</summary>",
			'"Added JWT auth"',
			"Title: Added JWT auth",
			"```md\n<summary>\nAdded JWT auth\n</summary>\n```",
		]) {
			expect(parseSummaryMarkdown(text)).toBe("Added JWT auth");
		}
	});

	test("repairs present tense and rejects non-verbs", () => {
		expect(repairSummaryTense("replace dependencies with local implementations")).toBe(
			"replaced dependencies with local implementations",
		);
		expect(normalizeSummaryVerb("refactor parser state", "refactor")).toBe("restructured parser state");
		expect(validateSummaryQuality("hundred files", "feat").ok).toBeFalse();
		expect(fallbackSummary(" src/api.ts | 3 ++-", [], "", { commitType: "fix" })).toBe("Updated src/api.ts");
	});
});

describe("llm-git generation routing", () => {
	test("uses one fast call for changes at the 200-line threshold", async () => {
		const inference = new QueueInference([
			"# fix(parser): corrected null dereference\n\n- Guarded empty parser input.",
		]);
		const result = await generateConventionalCommit({
			diff: SIMPLE_DIFF,
			stat: " src/parser.ts | 2 +-",
			numstat: "100\t100\tsrc/parser.ts\n",
			config: DEFAULT_CONFIG,
			inference,
		});
		expect(inference.operations).toEqual(["fast"]);
		expect(result.validationError).toBeNull();
		expect(result.commit).toMatchObject({
			type: "fix",
			scope: "parser",
			summary: "corrected null dereference",
			body: ["Guarded empty parser input."],
		});
	});

	test("accepts a valid holistic analysis summary without a second call", async () => {
		const inference = new QueueInference([
			"# feat(parser): added parser recovery\n\n- Added recovery after malformed input.",
		]);
		const result = await generateConventionalCommit({
			diff: SIMPLE_DIFF,
			stat: " src/parser.ts | 2 +-",
			numstat: "201\t0\tsrc/parser.ts\n",
			config: config({ mapReduceEnabled: false }),
			inference,
		});
		expect(inference.operations).toEqual(["analysis"]);
		expect(result.commit.summary).toBe("added parser recovery");
	});

	test("repairs a rejected generated summary before rewrite or fallback", async () => {
		const inference = new QueueInference([
			"# fix(parser): correct null dereference\n\n- Corrected parser handling.",
			"<summary>correct null dereference</summary>",
		]);
		const result = await generateConventionalCommit({
			diff: SIMPLE_DIFF,
			stat: " src/parser.ts | 2 +-",
			numstat: "201\t0\tsrc/parser.ts\n",
			config: config({ mapReduceEnabled: false }),
			inference,
		});
		expect(inference.operations).toEqual(["analysis", "summary"]);
		expect(result.commit.summary).toBe("corrected null dereference");
	});

	test("maps and reduces large diffs before building the message", async () => {
		const inference = new QueueInference([
			"# src/parser.ts\n- corrected parser branching",
			"# fix(parser): corrected parser branching\n\n- Corrected parser branching.",
		]);
		const result = await generateConventionalCommit({
			diff: SIMPLE_DIFF,
			stat: " src/parser.ts | 2 +-",
			numstat: "1\t1\tsrc/parser.ts\n",
			config: config({ autoFastThresholdLines: 0, mapReduceThreshold: 1 }),
			inference,
		});
		expect(inference.operations).toEqual(["map-reduce/map", "map-reduce/reduce"]);
		expect(result.commit.summary).toBe("corrected parser branching");
	});

	test("short-circuits whitespace-only changes without inference", async () => {
		const inference = new QueueInference([]);
		const result = await generateConventionalCommit({
			diff: `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-const x = 1;
+const  x = 1;`,
			stat: " a.ts | 2 +-",
			numstat: "1\t1\ta.ts\n",
			config: DEFAULT_CONFIG,
			inference,
		});
		expect(inference.operations).toEqual([]);
		expect(result.commit).toMatchObject({ type: "style", scope: null, summary: "reformatted a.ts" });
	});

	test("drops a scope that names the whole project", async () => {
		const inference = new QueueInference(["# fix(project): corrected parser crash\n\n- Corrected parser crash."]);
		const result = await generateConventionalCommit({
			diff: SIMPLE_DIFF,
			stat: " src/parser.ts | 2 +-",
			numstat: "201\t0\tsrc/parser.ts\n",
			config: config({ mapReduceEnabled: false }),
			inference,
			context: { projectNames: ["project"] },
		});
		expect(result.commit.scope).toBeNull();
		expect(result.validationError).toBeNull();
	});
});

describe("commit inference cache", () => {
	test("keys all request material and round-trips parsed response text", async () => {
		const material = {
			operation: "analysis",
			model: "anthropic/claude",
			apiMode: "anthropic-messages",
			toolName: "create_conventional_analysis",
			systemPrompt: "system",
			userPrompt: "user",
		};
		expect(computeCommitCacheKey(material)).toBe(computeCommitCacheKey(material));
		expect(computeCommitCacheKey({ ...material, userPrompt: "different" })).not.toBe(computeCommitCacheKey(material));

		using tempDir = TempDir.createSync("@omp-commit-cache-");
		const cache = await CommitInferenceCache.open(path.join(tempDir.path(), "cache.db"), 0);
		if (!cache) throw new Error("cache failed to open");
		expect(cache.get("k")).toBeNull();
		cache.put({
			key: "k",
			model: "model",
			operation: "analysis",
			request: "request",
			response: { text: "# fix: corrected bug", stopReason: "stop", costUsd: 0.01 },
		});
		expect(cache.get("k")).toEqual({ text: "# fix: corrected bug", stopReason: "stop", costUsd: 0.01 });
		cache.close();
	});
});
