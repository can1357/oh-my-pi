import { describe, expect, test } from "bun:test";
import {
	type ContextCategoryTokens,
	type ContextJournalEntry,
	type ContextSnapshotDetails,
	type ContextTimelineInput,
	DEFAULT_CONTEXT_LIMITS,
	foldContextTimeline,
} from "@oh-my-pi/pi-ai/context-insights";

const T0 = Date.parse("2026-10-21T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const CATEGORIES: ContextCategoryTokens = {
	systemPrompt: 20,
	systemTools: 30,
	systemContext: 10,
	skills: 20,
	messages: 40,
};

function details(promptCategories: ContextCategoryTokens = CATEGORIES) {
	return {
		contextWindow: 1000,
		categories: promptCategories,
		toolSchemas: [
			{ name: "read", tokens: 12 },
			{ name: "write", tokens: 18 },
		],
		skills: [{ name: "skill-a", tokens: 20 }],
		systemPromptParts: [20, 10],
		systemPromptPartsOmitted: 0,
		messageCount: 4,
		pendingMessageTokens: 0,
	};
}

function assistant(
	id: string,
	seconds: number,
	promptTokens: number,
	content: unknown[],
	options?: { details?: ContextSnapshotDetails; usage?: Record<string, number>; snapshot?: boolean },
): ContextJournalEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: at(seconds),
		message: {
			role: "assistant",
			timestamp: T0 + seconds * 1000,
			model: "model-a",
			provider: "provider-a",
			usage: {
				input: promptTokens - 10,
				output: 5,
				cacheRead: 10,
				cacheWrite: 0,
				total: promptTokens + 5,
				cost: { total: 0.25 },
				...options?.usage,
			},
			contextSnapshot:
				options?.snapshot === false
					? undefined
					: {
							promptTokens,
							nonMessageTokens: 80,
							toolSchemaTokens: 30,
							compactionEpoch: 0,
							...(options?.details ? { details: options.details } : {}),
						},
			content,
		},
	};
}

function toolResult(
	id: string,
	seconds: number,
	toolCallId: string,
	toolName: string,
	resultDetails?: unknown,
): ContextJournalEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: at(seconds),
		message: {
			role: "toolResult",
			timestamp: T0 + seconds * 1000,
			toolCallId,
			toolName,
			content: [],
			details: resultDetails,
			isError: false,
		},
	};
}

function baseEntries(): ContextJournalEntry[] {
	return [
		assistant(
			"a1",
			1,
			120,
			[
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "./a.ts" } },
				{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "b.ts", content: "a\nb\n" } },
				{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "search-1", name: "grep", arguments: { pattern: "needle" } },
			],
			{ details: details() },
		),
		toolResult("r1", 2, "read-1", "read", { totalLines: 10, fileSize: 100 }),
		toolResult("r2", 3, "write-1", "write", { resolvedPath: "b.ts" }),
		toolResult("r3", 4, "edit-1", "edit", { diff: "--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new\n" }),
		{ type: "compaction", id: "compact-1", timestamp: at(5), tokensBefore: 200, tokensAfter: 100, method: "soft" },
		{ type: "ttsr_injection", id: "inject-1", timestamp: at(6), injectedRules: ["rule-a", "rule-b"] },
		{ type: "model_change", id: "switch-1", timestamp: at(7), model: "model-b", role: "default" },
		assistant(
			"a2",
			8,
			100,
			[{ type: "toolCall", id: "write-2", name: "write", arguments: { path: "c.ts", content: "x\ny" } }],
			{ details: details() },
		),
		{ type: "reset_boundary", id: "reset-1", timestamp: at(9) },
		{ type: "custom_message", id: "inject-2", timestamp: at(10), customType: "system-reminder", content: "tail" },
		assistant("a3", 11, 0, [], {
			details: undefined,
			snapshot: false,
			usage: { input: 50, output: 5, cacheRead: 10, cacheWrite: 0, total: 65 },
		}),
		{ type: "unknown_future_entry", id: "future-1", timestamp: at(12) },
		assistant("a1", 13, 999, [], { details: details() }),
	];
}

function input(overrides: Partial<ContextTimelineInput> = {}): ContextTimelineInput {
	return {
		sessionId: "session-1",
		file: "/tmp/session-1.jsonl",
		cwd: "/work",
		source: "journal",
		entries: baseEntries(),
		normalizePath: p => (p.startsWith("/") ? p : `/work/${p.replace(/^\.\//, "")}`),
		...overrides,
	};
}

describe("foldContextTimeline", () => {
	test("builds steps, composition, signed remainder, events, and file activity", () => {
		const timeline = foldContextTimeline(input());

		expect(timeline.schemaVersion).toBe(1);
		expect(timeline.sessionId).toBe("session-1");
		expect(timeline.source).toBe("journal");
		expect(timeline.steps.map(step => step.promptTokens)).toEqual([120, 100, 60]);
		expect(timeline.steps.map(step => step.index)).toEqual([0, 1, 2]);
		expect(timeline.steps.map(step => step.anchored)).toEqual([true, true, false]);
		expect(timeline.steps[0]?.composition).toEqual(CATEGORIES);
		expect(timeline.steps[0]?.compositionEstimated).toBe(true);
		expect(timeline.steps[0]?.unattributed).toBe(0);
		expect(timeline.steps[1]?.unattributed).toBe(-20);
		expect(timeline.steps[2]?.composition).toBeUndefined();
		expect(timeline.steps[2]?.unattributed).toBeUndefined();
		expect(timeline.legacySteps).toBe(1);
		expect(timeline.composition).toBeUndefined();
		expect(timeline.peakTokens).toBe(120);
		expect(timeline.steps[1]?.deltaTokens).toBe(-20);
		expect(timeline.steps[1]?.deltaKind).toBe("compaction");
		expect(timeline.steps[2]?.deltaKind).toBe("reset");

		expect(timeline.events.map(event => event.kind)).toEqual(["compact", "inject", "switch", "reset", "inject"]);
		expect(timeline.events.map(event => event.stepIndex)).toEqual([1, 1, 1, 2, 2]);
		expect(timeline.steps[1]?.eventIds).toEqual(["compact-1", "inject-1", "switch-1"]);
		expect(timeline.steps[2]?.eventIds).toEqual(["reset-1", "inject-2"]);
		expect(timeline.steps[0]?.eventIds).toEqual([]);

		const byPath = new Map(timeline.files.map(file => [file.path, file]));
		expect(byPath.get("/work/a.ts")).toMatchObject({
			reads: 1,
			edits: 1,
			linesRead: 10,
			linesAdded: 1,
			linesRemoved: 1,
			bytesRead: 100,
		});
		expect(byPath.get("/work/b.ts")).toMatchObject({ writes: 1, linesAdded: 2, bytesWritten: 4 });
		expect(byPath.get("/work/c.ts")).toMatchObject({ writes: 1, linesAdded: 2, bytesWritten: 3 });
		expect(byPath.get("(search)")).toMatchObject({ searches: 1 });
		expect(timeline.incompleteFileCalls).toBe(1);
		expect(timeline.detailsOmittedSteps).toBe(0);
		expect(timeline.omittedSteps).toBe(0);
		expect(timeline.truncated).toBe(false);
	});

	test("returns bounded step details without turning modern steps into legacy", () => {
		const timeline = foldContextTimeline(input({ limits: { maxBrowserEntries: 0, maxSteps: 100, maxEvents: 100 } }));
		expect(timeline.steps.every(step => step.details === undefined)).toBe(true);
		expect(timeline.detailsOmittedSteps).toBe(2);
		expect(timeline.legacySteps).toBe(1);
		expect(timeline.steps[0]?.composition).toEqual(CATEGORIES);
		expect(timeline.steps[1]?.composition).toEqual(CATEGORIES);
		expect(timeline.truncated).toBe(true);
	});

	test("honors step, event, file, and browser budgets with absolute indices", () => {
		const timeline = foldContextTimeline(
			input({
				limits: {
					maxSteps: 3,
					maxEvents: 1,
					maxFiles: 2,
					maxBrowserEntries: 5,
				},
			}),
		);
		expect(timeline.steps.map(step => step.index)).toEqual([0, 1, 2]);
		expect(timeline.omittedSteps).toBe(0);
		expect(timeline.events).toHaveLength(1);
		expect(timeline.events[0]?.kind).toBe("inject");
		expect(timeline.omittedEvents).toBe(4);
		expect(timeline.files.length).toBeLessThanOrEqual(2);
		expect(timeline.omittedFiles).toBeGreaterThan(0);
		expect(timeline.steps[0]?.details).toBeUndefined();
		expect(timeline.steps[1]?.details).toBeDefined();
		expect(timeline.steps[2]?.details).toBeUndefined();
		expect(timeline.detailsOmittedSteps).toBe(1);
		expect(timeline.truncated).toBe(true);
		expect(timeline.steps[0]?.eventIds).toEqual([]);
	});

	test("defaults are the documented caps and malformed entries are ignored", () => {
		expect(DEFAULT_CONTEXT_LIMITS).toMatchObject({
			maxSteps: 1000,
			maxEvents: 200,
			maxFiles: 500,
			maxBrowserEntries: 500,
			maxToolSchemas: 200,
			maxSkills: 200,
			maxSystemParts: 20,
		});
		const timeline = foldContextTimeline(
			input({
				entries: [
					{ type: "unknown_future_entry", id: "x" },
					{ type: "compaction", id: "bad-compact", timestamp: "not-a-date" },
					assistant("a1", 1, 10, [], { details: undefined }),
				],
			}),
		);
		expect(timeline.steps).toHaveLength(1);
		expect(timeline.events.map(event => event.id)).toEqual(["bad-compact"]);
		expect(timeline.events[0]?.timestamp).toBe(0);
		expect(timeline.steps[0]?.promptTokens).toBe(10);
		expect(timeline.steps[0]?.anchored).toBe(true);
	});

	test("uses normalizePath for tool paths and keeps searches out of path resolution", () => {
		const seen: string[] = [];
		const timeline = foldContextTimeline(
			input({
				normalizePath: p => {
					seen.push(p);
					return `N:${p}`;
				},
			}),
		);
		expect(seen).toContain("./a.ts");
		expect(seen).toContain("b.ts");
		expect(seen).not.toContain("(search)");
		expect(timeline.files.some(file => file.path === "N:./a.ts")).toBe(true);
		expect(timeline.files.some(file => file.path === "(search)")).toBe(true);
	});

	test("leaves trailing events without a step index", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant("a1", 1, 10, [], { details: undefined }),
					{ type: "custom_message", id: "tail", timestamp: at(2), customType: "tail", content: "x" },
				],
			}),
		);
		expect(timeline.events).toHaveLength(1);
		expect(timeline.events[0]?.stepIndex).toBeUndefined();
		expect(timeline.steps[0]?.eventIds).toEqual([]);
	});

	test("folds ast_edit multi-path calls and results", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant("a1", 1, 10, [
						{
							type: "toolCall",
							id: "ast-1",
							name: "ast_edit",
							arguments: { ops: [{ pat: "old()", out: "new()" }], paths: ["src/a.ts", "src/b.ts"] },
						},
						{
							type: "toolCall",
							id: "ast-2",
							name: "ast_edit",
							arguments: { ops: [{ pat: "x", out: "y" }], paths: ["src/c.ts"] },
						},
					]),
					toolResult("r1", 2, "ast-1", "ast_edit", {
						files: ["src/a.ts", "src/b.ts"],
						fileReplacements: [{ path: "src/b.ts", count: 2 }],
					}),
				],
			}),
		);
		expect(timeline.files.map(file => file.path)).toEqual(["/work/src/a.ts", "/work/src/b.ts", "/work/src/c.ts"]);
		expect(Object.fromEntries(timeline.files.map(file => [file.path, file.edits]))).toEqual({
			"/work/src/a.ts": 1,
			"/work/src/b.ts": 1,
			"/work/src/c.ts": 1,
		});
		expect(timeline.steps[0]?.filePaths).toEqual(["/work/src/a.ts", "/work/src/b.ts", "/work/src/c.ts"]);
		expect(timeline.incompleteFileCalls).toBe(1);
	});

	test("deduplicates ast_edit spellings and replaces selectors with concrete files", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant("a1", 1, 10, [
						{
							type: "toolCall",
							id: "ast-dup",
							name: "ast_edit",
							arguments: { ops: [], paths: ["src/a.ts", "./src/a.ts"] },
						},
						{
							type: "toolCall",
							id: "ast-glob",
							name: "ast_edit",
							arguments: { ops: [], paths: ["src/*.ts"] },
						},
						{
							type: "toolCall",
							id: "ast-glob-2",
							name: "ast_edit",
							arguments: { ops: [], paths: ["src/*.ts"] },
						},
					]),
					toolResult("r1", 2, "ast-dup", "ast_edit", { files: ["src/a.ts"] }),
					toolResult("r2", 2, "ast-glob", "ast_edit", {
						files: ["src/x.ts", "src/y.ts"],
						fileReplacements: [{ path: "src/y.ts", count: 1 }],
					}),
					toolResult("r3", 2, "ast-glob-2", "ast_edit", { files: ["src/x.ts"] }),
				],
			}),
		);
		expect(timeline.files.map(file => file.path).sort()).toEqual([
			"/work/src/a.ts",
			"/work/src/x.ts",
			"/work/src/y.ts",
		]);
		expect(Object.fromEntries(timeline.files.map(file => [file.path, file.edits]))).toEqual({
			"/work/src/a.ts": 1,
			"/work/src/x.ts": 2,
			"/work/src/y.ts": 1,
		});
		expect(timeline.steps[0]?.filePaths.sort()).toEqual(["/work/src/a.ts", "/work/src/x.ts", "/work/src/y.ts"]);
		expect(timeline.incompleteFileCalls).toBe(0);
	});

	test("keeps a shared selector owned by an unresolved ast_edit call", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant("a1", 1, 10, [
						{
							type: "toolCall",
							id: "ast-resolved",
							name: "ast_edit",
							arguments: { ops: [], paths: ["src/*.ts"] },
						},
						{
							type: "toolCall",
							id: "ast-pending",
							name: "ast_edit",
							arguments: { ops: [], paths: ["src/*.ts"] },
						},
					]),
					toolResult("r1", 2, "ast-resolved", "ast_edit", { files: ["src/0.ts"] }),
				],
			}),
		);
		expect(timeline.files.map(file => [file.path, file.edits]).sort()).toEqual([
			["/work/src/*.ts", 1],
			["/work/src/0.ts", 1],
		]);
		expect(timeline.steps[0]?.filePaths.sort()).toEqual(["/work/src/*.ts", "/work/src/0.ts"]);
		expect(timeline.incompleteFileCalls).toBe(1);
	});

	test("keeps cost across the step cap", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [assistant("a1", 1, 10, []), assistant("a2", 2, 20, []), assistant("a3", 3, 30, [])],
				limits: { maxSteps: 1 },
			}),
		);
		expect(timeline.steps.map(step => step.id)).toEqual(["a3"]);
		expect(timeline.omittedSteps).toBe(2);
		expect(timeline.costTotal).toBe(0.75);
		expect(timeline.peakTokensTotal).toBe(30);
		expect(timeline.peakTokens).toBe(30);
	});

	test("zero step and event limits return empty windows", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant("a1", 1, 10, [], { details: undefined }),
					{ type: "reset_boundary", id: "reset-1", timestamp: at(2) },
				],
				limits: { maxSteps: 0, maxEvents: 0 },
			}),
		);
		expect(timeline.steps).toEqual([]);
		expect(timeline.events).toEqual([]);
		expect(timeline.omittedSteps).toBe(1);
		expect(timeline.omittedEvents).toBe(1);
		expect(timeline.peakTokens).toBe(0);
		expect(timeline.composition).toBeUndefined();
		expect(timeline.truncated).toBe(true);
	});

	test("ignores non-file tools even when they carry a path", () => {
		const seen: string[] = [];
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant("a1", 1, 10, [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { path: "a.ts" } }], {
						details: undefined,
					}),
				],
				normalizePath: p => {
					seen.push(p);
					return p;
				},
			}),
		);
		expect(timeline.files).toEqual([]);
		expect(timeline.steps[0]?.filePaths).toEqual([]);
		expect(timeline.incompleteFileCalls).toBe(0);
		expect(seen).toEqual([]);
	});

	test("does not turn excluded search targets into the search bucket", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant(
						"a1",
						1,
						10,
						[{ type: "toolCall", id: "grep-1", name: "grep", arguments: { path: "artifact://x" } }],
						{ details: undefined },
					),
				],
			}),
		);
		expect(timeline.files).toEqual([]);
		expect(timeline.steps[0]?.filePaths).toEqual([]);
	});

	test("migrates a resolved write path in the owning step", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant(
						"a1",
						1,
						10,
						[{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "a.ts", content: "x" } }],
						{ details: undefined },
					),
					toolResult("r1", 2, "write-1", "write", { resolvedPath: "b.ts" }),
				],
			}),
		);
		expect(timeline.files.map(file => file.path)).toEqual(["/work/b.ts"]);
		expect(timeline.files[0]).toMatchObject({ writes: 1, linesAdded: 1, bytesWritten: 1 });
		expect(timeline.steps[0]?.filePaths).toEqual(["/work/b.ts"]);
	});

	test("does not retain a previous path because an earlier step used it", () => {
		const timeline = foldContextTimeline(
			input({
				entries: [
					assistant(
						"reader",
						1,
						10,
						[{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }],
						{ details: undefined },
					),
					toolResult("read-result", 2, "read-1", "read", { totalLines: 1 }),
					assistant(
						"writer",
						3,
						10,
						[{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "a.ts", content: "x" } }],
						{ details: undefined },
					),
					toolResult("write-result", 4, "write-1", "write", { resolvedPath: "b.ts" }),
				],
			}),
		);
		expect(timeline.steps[0]?.filePaths).toEqual(["/work/a.ts"]);
		expect(timeline.steps[1]?.filePaths).toEqual(["/work/b.ts"]);
	});
});
