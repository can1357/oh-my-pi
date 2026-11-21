import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	blankUnseenNumbers,
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoffFromContext,
	generateSummary,
	numbersSeenIn,
	SummaryNumberCheck,
	unseenNumbers,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as snapcompact from "@oh-my-pi/snapcompact";

/**
 * Defends `compaction.numberCheck`: a summary may keep only numbers its input
 * showed. Unseen ones go back to the writer once in the summary request's fork;
 * any still unseen become `?`. List and heading numbering are structure, not values.
 */

function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
	};
}

function getModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

const messages: AgentMessage[] = [
	{ role: "user", content: "run the suite and report", timestamp: 1 },
	reply("The suite ran: 4817 tests passed in 73.25s, coverage 88.4%."),
];

interface Call {
	context: Context;
	options: SimpleStreamOptions;
}

/** A writer that answers the summary request with `summary`, then each later request with `fixes` in order. */
function writer(summary: string, ...fixes: AssistantMessage[]) {
	const calls: Call[] = [];
	const completeImpl = async (_model: Model, context: Context, options: SimpleStreamOptions) => {
		calls.push({ context, options });
		return calls.length === 1 ? reply(summary) : (fixes[calls.length - 2] ?? reply(""));
	};
	return { calls, completeImpl };
}

function lastUserText(context: Context): string {
	const last = context.messages.at(-1);
	if (!last || last.role !== "user" || typeof last.content === "string") return String(last?.content);
	return last.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function summarize(summary: string, ...fixes: AssistantMessage[]) {
	const check = new SummaryNumberCheck();
	const mock = writer(summary, ...fixes);
	const result = generateSummary(messages, getModel(), 16_384, "test-key", undefined, undefined, undefined, {
		completeImpl: mock.completeImpl,
		oneshotRetry: false,
		numberCheck: check,
	});
	return { result, check, calls: mock.calls };
}

describe("compaction.numberCheck", () => {
	test("keeps numbers the input showed without a fix request", async () => {
		const summary = "## Progress\n- 4817 tests pass (73.25s), coverage 88.4%";
		const { result, check, calls } = summarize(summary);

		expect(await result).toBe(summary);
		expect(calls).toHaveLength(1);
		expect(check.report).toBeUndefined();
	});

	test("sends a fabricated number back once in the summary request's fork and applies the line fix", async () => {
		const summary = "## Progress\n- 4871 tests pass\n- coverage 88.4%";
		const { result, check, calls } = summarize(summary, reply("OLD: - 4871 tests pass\nNEW: - 4817 tests pass"));

		expect(await result).toBe("## Progress\n- 4817 tests pass\n- coverage 88.4%");
		expect(calls).toHaveLength(2);
		const [first, fix] = calls;
		// Same prefix and cache routing: the summary request, its reply, then the question.
		expect(fix.context.systemPrompt).toEqual(first.context.systemPrompt);
		expect(fix.context.messages.slice(0, first.context.messages.length)).toEqual(first.context.messages);
		expect(fix.context.messages[first.context.messages.length]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: summary }],
		});
		// The question gives the line that holds the number, so the writer can copy it as OLD.
		expect(lastUserText(fix.context)).toContain("`4871` in: - 4871 tests pass");
		expect(fix.options.maxTokens).toBe(first.options.maxTokens);
		expect(check.report).toEqual({ unseenNumbers: ["4871"], blanked: [] });
	});

	test("blanks a number the fix round left unseen and refuses fixes to other lines", async () => {
		const summary = "## Progress\n- 4871 tests pass\n- coverage 88.4%";
		const { result, check, calls } = summarize(
			summary,
			// Neither fix applies: the first targets a line with no unseen number, the second keeps the number.
			reply("OLD: - coverage 88.4%\nNEW: - coverage unknown\nOLD: - 4871 tests pass\nNEW: - 4871 tests passed"),
		);

		expect(await result).toBe("## Progress\n- ? tests passed\n- coverage 88.4%");
		expect(calls).toHaveLength(2);
		expect(check.report).toEqual({ unseenNumbers: ["4871"], blanked: ["4871"] });
	});

	test("blanks unseen numbers when the fix request fails", async () => {
		const { result, check } = summarize("- took 97.5s", reply("", "error"));

		expect(await result).toBe("- took ?s");
		expect(check.report).toEqual({ unseenNumbers: ["97.5"], blanked: ["97.5"] });
	});

	test("leaves list ordinals and heading section numbers alone", async () => {
		const summary = "## 2. Next Steps\n### 3.1 Scope\n1. rerun the suite\n12) report 4817 passes";
		const { result, calls } = summarize(summary);

		expect(await result).toBe(summary);
		expect(calls).toHaveLength(1);
	});

	test("leaves digits inside identifiers alone", () => {
		const seen = numbersSeenIn(["edited src/auth/oauth2.ts at commit 9f3c2e1a7b, tests pass"]);
		const summary = "tokens are base64url, served over HTTP/2 on IPv6\n- Model: claude-sonnet-4-5";

		expect(unseenNumbers(summary, seen)).toEqual([]);
		expect(blankUnseenNumbers(summary, seen)).toBe(summary);
	});

	test("reads a long digit run in linear time and keeps its versions and lists", () => {
		const run = "1".repeat(60_000);
		const start = performance.now();
		const seen = numbersSeenIn([`value ${run} then 18.20.2 and ids 120, 126`]);
		expect(performance.now() - start).toBeLessThan(1_000);

		expect(seen.has(run)).toBe(true);
		expect(seen.has("18.20.2")).toBe(true);
		expect(seen.has("120,126")).toBe(true);
	});

	test("skips code but still checks standalone numbers with units and versions", () => {
		const seen = numbersSeenIn(["upgraded to 18.20.2; bundle is 4KB, 3x smaller, 12ms load"]);
		const summary = [
			"- ran `sleep 9999` first",
			"```sh",
			"exit 4242",
			"```",
			"- version 18.20.3, 4KB, 3x, 12ms, 1234 left",
		].join("\n");

		expect(unseenNumbers(summary, seen)).toEqual(["1234", "18.20.3"]);
		expect(blankUnseenNumbers(summary, seen)).toBe(
			["- ran `sleep 9999` first", "```sh", "exit 4242", "```", "- version ?, 4KB, 3x, 12ms, ? left"].join("\n"),
		);
	});

	test("reads a packed list as seen only when one input list holds every item", async () => {
		const mock = writer("ids 120,126 and 125,135");
		const check = new SummaryNumberCheck();
		const result = await generateSummary(
			[{ role: "user", content: "ids 120, 126, 131 then 125 and later 135", timestamp: 1 }],
			getModel(),
			16_384,
			"test-key",
			undefined,
			undefined,
			undefined,
			{ completeImpl: mock.completeImpl, oneshotRetry: false, numberCheck: check },
		);

		expect(result).toBe("ids 120,126 and ?");
		expect(check.report?.blanked).toEqual(["125,135"]);
	});

	test("runs on handoff documents with the handoff request options", async () => {
		const context: Context = {
			systemPrompt: ["system"],
			messages: [{ role: "user", content: "build finished in 312ms", timestamp: 1 }],
		};
		const mock = writer(
			"## Goal\nship\n- build took 321ms",
			reply("OLD: - build took 321ms\nNEW: - build took 312ms"),
		);
		const check = new SummaryNumberCheck();

		const document = await generateHandoffFromContext(context, getModel(), {
			streamOptions: { apiKey: "test-key", promptCacheKey: "live-cache-key" },
			completeImpl: mock.completeImpl,
			numberCheck: check,
		});

		expect(document).toBe("## Goal\nship\n- build took 312ms");
		expect(mock.calls[1].options).toMatchObject({ promptCacheKey: "live-cache-key", toolChoice: "none" });
		expect(mock.calls[1].context.messages.slice(0, 1)).toEqual(context.messages);
	});

	test("records unseen and blanked numbers on the compaction details only when enabled", async () => {
		const preparation = (numberCheck: boolean): CompactionPreparation => ({
			firstKeptEntryId: "kept",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			recentMessages: [{ role: "user", content: "recent", timestamp: 3 }],
			isSplitTurn: false,
			tokensBefore: 10_000,
			fileOps: snapcompact.createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false, numberCheck },
		});
		const completeImpl = async (_model: Model, context: Context) =>
			reply(lastUserText(context).includes("OLD:") ? "OLD: nothing\nNEW: nothing" : "- 5555 tests pass");

		const checked = await compact(preparation(true), getModel(), "test-key", undefined, undefined, { completeImpl });
		const unchecked = await compact(preparation(false), getModel(), "test-key", undefined, undefined, {
			completeImpl,
		});

		expect(checked.summary).toStartWith("- ? tests pass");
		expect(checked.details).toMatchObject({ numberCheck: { unseenNumbers: ["5555"], blanked: ["5555"] } });
		expect(unchecked.summary).toStartWith("- 5555 tests pass");
		expect(unchecked.details).not.toHaveProperty("numberCheck");
	});
});
