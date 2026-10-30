import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	buildStepDigest,
	localStepSummary,
	normalizeStepSummary,
	STEP_SUMMARY_CUSTOM_TYPE,
	stepSummariesFromEntries,
	stepSummaryTone,
} from "@oh-my-pi/pi-coding-agent/step-summary/step-summarizer";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

function result(toolCallId: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	};
}

function toolResult(toolCallId: string, toolName: string, details: unknown, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "" }],
		details,
		isError,
		timestamp: 2,
	};
}

describe("localStepSummary", () => {
	it("captions read-only search steps from arguments and result counts", () => {
		expect(
			localStepSummary({
				message: assistant([
					{ type: "toolCall", id: "g", name: "grep", arguments: { pattern: "retryLoop", path: "src" } },
					{ type: "toolCall", id: "f", name: "glob", arguments: { path: "src/**/*.md" } },
					{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/session/manager.ts:50-80" } },
					{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/b.ts" } },
					{ type: "toolCall", id: "r3", name: "read", arguments: { path: "src/session/manager.ts:200-220" } },
				]),
				toolResults: [
					toolResult("g", "grep", { matchCount: 3, fileCount: 1 }),
					toolResult("f", "glob", { fileCount: 0 }),
					toolResult("r1", "read", {}),
					toolResult("r2", "read", {}),
					toolResult("r3", "read", {}),
				],
			}),
		).toBe("Found 3 matches for retryLoop in 1 file; no files matching src/**/*.md; read manager.ts and b.ts");
		expect(
			localStepSummary({
				message: assistant(
					["a", "b", "c", "d", "e"].map(name => ({
						type: "toolCall" as const,
						id: name,
						name: "read",
						arguments: { path: `${name}.ts` },
					})),
				),
				toolResults: ["a", "b", "c", "d", "e"].map(name => toolResult(name, "read", {})),
			}),
		).toBe("Read a.ts, b.ts, c.ts and 2 more");
	});

	it("leaves failed, mixed, remote, or count-less steps to the model", () => {
		const grep = { type: "toolCall" as const, id: "g", name: "grep", arguments: { pattern: "x" } };
		const caption = (calls: AssistantMessage["content"], results: ToolResultMessage[]) =>
			localStepSummary({ message: assistant(calls), toolResults: results });
		expect(caption([grep], [toolResult("g", "grep", { matchCount: 1 }, true)])).toBe(undefined);
		expect(caption([grep], [toolResult("g", "grep", { matchCount: 0, error: "bad regex" })])).toBe(undefined);
		expect(caption([grep], [toolResult("g", "grep", {})])).toBe(undefined);
		expect(caption([grep], [])).toBe(undefined);
		expect(
			caption(
				[grep, { type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } }],
				[toolResult("g", "grep", { matchCount: 1 }), toolResult("b", "bash", {})],
			),
		).toBe(undefined);
		expect(
			caption(
				[{ type: "toolCall", id: "r", name: "read", arguments: { path: "https://example.com/a.md" } }],
				[toolResult("r", "read", {})],
			),
		).toBe(undefined);
		expect(caption([{ type: "text", text: "done" }], [])).toBe(undefined);
	});
});

describe("buildStepDigest", () => {
	it("skips steps without tool calls: their reply already says what happened", () => {
		expect(buildStepDigest({ message: assistant([{ type: "text", text: "All done." }]), toolResults: [] })).toBe(
			undefined,
		);
	});

	it("pairs each call with its result, flags failures, and stays bounded for huge output", () => {
		const digest = buildStepDigest({
			request: "fix the build",
			message: assistant([
				{ type: "toolCall", id: "a", name: "bash", arguments: { command: "bun check" } },
				{ type: "toolCall", id: "b", name: "read", arguments: { path: "big.log" } },
				{ type: "toolCall", id: "c", name: "bash", arguments: { command: "sleep 1" } },
			]),
			toolResults: [result("b", "x".repeat(100_000)), result("a", "error TS2339", true)],
		});
		expect(digest).toContain("Request: fix the build");
		expect(digest).toContain("Result 1 (error): error TS2339");
		expect(digest).toContain("Result 3: (none)");
		expect(digest?.length).toBeLessThanOrEqual(6000);
	});

	it("reads only the head of huge results, arguments, and replies, and no calls past a full digest", () => {
		const reads = { blocks: 0, members: 0, items: 0 };
		// Instrumented sources: every block, member, and item read is counted.
		const blocks = Array.from({ length: 10_000 }, () => ({
			type: "text" as const,
			get text() {
				reads.blocks += 1;
				return "line ".repeat(200);
			},
		}));
		const args: Record<string, unknown> = {};
		for (let i = 0; i < 10_000; i++) {
			Object.defineProperty(args, `key${i}`, {
				enumerable: true,
				get() {
					reads.members += 1;
					return "value ".repeat(50);
				},
			});
		}
		const items = new Proxy(
			Array.from({ length: 10_000 }, (_, i) => i),
			{
				get(target, key, receiver) {
					if (typeof key === "string" && /^\d+$/.test(key)) reads.items += 1;
					return Reflect.get(target, key, receiver);
				},
			},
		);
		const huge = "x".repeat(8 * 1024 * 1024);
		const calls = Array.from({ length: 1_000 }, (_, i) => ({
			type: "toolCall" as const,
			id: `late${i}`,
			name: "bash",
			get arguments(): Record<string, unknown> {
				throw new Error(`call ${i} past the digest cap was read`);
			},
		}));
		const digest = buildStepDigest({
			// The 400-character cut lands between the halves of the emoji: neither half may survive alone.
			request: `${"y".repeat(398)}\ud83d\ude00${huge}`,
			message: assistant([
				{ type: "thinking", thinking: huge },
				{ type: "text", text: huge },
				{ type: "toolCall", id: "a", name: "read", arguments: { path: huge } },
				{ type: "toolCall", id: "b", name: "bash", arguments: args },
				{ type: "toolCall", id: "c", name: "edit", arguments: { nested: { tab: "a\tb\nc" }, items } },
				{ type: "toolCall", id: "d", name: "bash", arguments: { command: "x" } },
				{ type: "toolCall", id: "e", name: "bash", arguments: { command: "x" } },
				{ type: "toolCall", id: "f", name: "read", arguments: { path: huge } },
				...calls,
			] as AssistantMessage["content"]),
			toolResults: [
				result("a", huge),
				{ ...result("b", ""), content: blocks },
				result("c", `${"\n".repeat(5_000_000)}tail`),
				result("f", huge),
			],
		});
		if (!digest) throw new Error("expected a digest");
		expect(digest.length).toBeLessThanOrEqual(6000);
		expect(digest).toContain(`Request: ${"y".repeat(398)}…\n`);
		expect(digest).toMatch(/Thinking: x{1999}…\nSaid: x{599}…\n/);
		expect(digest).toContain(`Call 1: read {"path":"${"x".repeat(20)}`);
		expect(digest).toMatch(/Result 1: x{599}…\n/);
		expect(digest).toContain('Call 2: bash {"key0":"value value');
		expect(digest).toMatch(/Result 2: line line .*…\n/);
		expect(digest).toContain('Call 3: edit {"nested":{"tab":"a\\tb\\nc"},"items":[0,1,2,');
		expect(digest).toContain("Result 3: …\n");
		expect(digest).toContain("Result 5: (none)");
		expect(digest).toContain("Call 6: read");
		expect(digest).not.toContain("Call 7:");
		expect(reads.blocks).toBeLessThanOrEqual(3);
		expect(reads.members).toBeLessThanOrEqual(5);
		expect(reads.items).toBeLessThanOrEqual(600);
		expect(digest).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
	});

	it("bounds members that serialize to nothing and the earlier-step list", () => {
		let reads = 0;
		const silent: Record<string, unknown> = {};
		for (let i = 0; i < 100_000; i++) {
			Object.defineProperty(silent, `skip${i}`, {
				enumerable: true,
				get() {
					reads += 1;
					return undefined;
				},
			});
		}
		const recent = Array.from({ length: 10_000 }, (_, i) => `step ${i} ${"z".repeat(500)}`);
		const digest = buildStepDigest(
			{
				message: assistant([
					{ type: "toolCall", id: "a", name: "bash", arguments: silent },
				] as AssistantMessage["content"]),
				toolResults: [result("a", "ok")],
			},
			recent,
		);
		if (!digest) throw new Error("expected a digest");
		expect(digest.length).toBeLessThanOrEqual(6000);
		expect(reads).toBeLessThanOrEqual(1201);
		expect(digest).toContain("Call 1: bash {…");
		expect(digest).toMatch(/Earlier steps: step 9998 z+…; step 9999 z+…\n/);
		expect(digest).not.toContain("step 9997");
	});
});

describe("normalizeStepSummary", () => {
	it("reduces a chatty reply to one plain caption line", () => {
		expect(normalizeStepSummary('\n- **Summary:** "Fixed the `add` operator in calc.py."\nMore detail')).toBe(
			"Fixed the add operator in calc.py",
		);
		expect(normalizeStepSummary("Raised max_tokens in the `_retry` helper.")).toBe(
			"Raised max_tokens in the _retry helper",
		);
		expect(normalizeStepSummary("  \n ** \n")).toBe(undefined);
		expect(normalizeStepSummary("word ".repeat(60))?.length).toBe(120);
	});
});

describe("stepSummariesFromEntries", () => {
	it("restores captions and their tones by message timestamp, ignoring malformed or foreign entries", () => {
		const summaries = stepSummariesFromEntries([
			{
				type: "custom",
				customType: STEP_SUMMARY_CUSTOM_TYPE,
				data: { messageTimestamp: 10, summary: "Ran the tests" },
			},
			{
				type: "custom",
				customType: STEP_SUMMARY_CUSTOM_TYPE,
				data: { messageTimestamp: 15, summary: "Build failed", tone: "error" },
			},
			{
				type: "custom",
				customType: STEP_SUMMARY_CUSTOM_TYPE,
				data: { messageTimestamp: 16, summary: "Unknown tone", tone: "purple" },
			},
			{
				type: "custom",
				customType: STEP_SUMMARY_CUSTOM_TYPE,
				data: { messageTimestamp: "11", summary: "bad stamp" },
			},
			{ type: "custom", customType: STEP_SUMMARY_CUSTOM_TYPE, data: { messageTimestamp: 12, summary: "" } },
			{ type: "custom", customType: STEP_SUMMARY_CUSTOM_TYPE, data: null },
			{ type: "custom", customType: "other", data: { messageTimestamp: 13, summary: "not ours" } },
			{ type: "message", data: { messageTimestamp: 14, summary: "not custom" } },
		]);
		expect([...summaries]).toEqual([
			[10, { text: "Ran the tests" }],
			[15, { text: "Build failed", tone: "error" }],
			[16, { text: "Unknown tone" }],
		]);
	});
});

describe("stepSummaryTone", () => {
	it("is error when every call failed, warning when some did, and absent otherwise", () => {
		expect(stepSummaryTone([result("a", "ok"), result("b", "ok")])).toBe(undefined);
		expect(stepSummaryTone([result("a", "ok"), result("b", "boom", true)])).toBe("warning");
		expect(stepSummaryTone([result("a", "boom", true), result("b", "boom", true)])).toBe("error");
	});
});
