import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import {
	dedupedNotice,
	MIN_DEDUPE_TOKENS,
	pruneSupersededToolResults,
	readToolSupersedeKey,
	SUPERSEDED_NOTICE,
	type SessionEntry,
	type SessionMessageEntry,
	type SupersedePruneConfig,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentContext, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

const tokenizer = new Tokenizer();
const T0 = Date.UTC(2026, 10, 28, 12, 0, 0);
const STATUS_OUTPUT = "On branch dev\nChanges not staged for commit:\n\tmodified:   src/session/foo.ts\n".repeat(20);
const OTHER_OUTPUT = "On branch dev\nnothing to commit, working tree clean\n".repeat(20);

let idCounter = 0;

function messageEntry(message: AgentMessage, timestamp: number): SessionMessageEntry {
	return {
		type: "message",
		id: `entry-${idCounter++}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message,
	};
}

function assistant(content: AssistantMessage["content"], timestamp: number): SessionMessageEntry {
	return messageEntry(
		{
			role: "assistant",
			content,
			timestamp,
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
			stopReason: "toolUse",
		},
		timestamp,
	);
}

function result(call: ToolCall, text: string, timestamp: number): SessionMessageEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
	return messageEntry(message, timestamp);
}

function toolCall(name: string, args: Record<string, unknown>, record: Partial<ToolCall> = {}): ToolCall {
	return { type: "toolCall", id: `call-${idCounter++}`, name, arguments: args, ...record };
}

/** One assistant turn issuing one call, plus its result. */
function turn(
	name: string,
	args: Record<string, unknown>,
	text: string,
	timestamp: number,
	record: Partial<ToolCall> = {},
): SessionMessageEntry[] {
	const call = toolCall(name, args, record);
	return [assistant([call], timestamp), result(call, text, timestamp)];
}

/** The agent loop's record of a call whose top-level `i` it stripped as harness intent. */
const STRIPPED = { intentStripped: true } as const;

function text(entry: SessionEntry): string {
	return (((entry as SessionMessageEntry).message as ToolResultMessage).content[0] as TextContent).text;
}

function prunedAt(entry: SessionEntry): number | undefined {
	return ((entry as SessionMessageEntry).message as ToolResultMessage).prunedAt;
}

function dedupe(entries: SessionEntry[], over: Partial<SupersedePruneConfig> = {}) {
	return pruneSupersededToolResults(entries, tokenizer, {
		dedupeIdentical: true,
		protectedTools: [],
		now: T0 + 10_000,
		...over,
	});
}

const GIT_STATUS = { command: "git status" };

/** A tool returning `output` for every call. */
function agentTool(name: string, parameters: AgentTool["parameters"], output: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters,
		async execute() {
			return { content: [{ type: "text", text: output }] };
		},
	};
}

/** Run one prompt through the agent loop with intent tracing; returns `history` plus the new messages. */
async function runLoop(tools: AgentTool[], history: AgentMessage[], calls: ToolCall[]): Promise<AgentMessage[]> {
	const responses: MockResponse[] = [...calls.map(call => ({ content: [call] })), { content: ["done"] }];
	const mock = createMockModel({ responses });
	const context: AgentContext = { systemPrompt: [""], messages: [...history], tools };
	const convertToLlm = (messages: AgentMessage[]) =>
		messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
	const stream = agentLoop(
		[createUserMessage("read the guide")],
		context,
		{ model: mock.model, convertToLlm, intentTracing: true },
		undefined,
		mock.stream,
	);
	for await (const _event of stream) {
		// drain
	}
	return [...history, ...(await stream.result())];
}

describe("pruneSupersededToolResults: identical-result dedupe", () => {
	test("blanks the older copy of an identical result from a later turn", () => {
		const [olderCall, older] = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0);
		const [newerCall, newer] = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + 1_000);

		const pruned = dedupe([olderCall, older, newerCall, newer]);

		expect(pruned.prunedCount).toBe(1);
		expect(pruned.tokensSaved).toBeGreaterThan(0);
		expect(text(older)).toBe(dedupedNotice("bash"));
		expect(prunedAt(older)).toBeDefined();
		expect(text(newer)).toBe(STATUS_OUTPUT);
		expect(prunedAt(newer)).toBeUndefined();
	});

	test("argument key order and harness intent do not split a call's identity", () => {
		const first = turn("grep", { pattern: "foo", path: "src", i: "look for foo" }, STATUS_OUTPUT, T0, STRIPPED);
		const second = turn("grep", { path: "src", pattern: "foo", i: "again" }, STATUS_OUTPUT, T0 + 1_000, STRIPPED);

		expect(dedupe([...first, ...second]).prunedCount).toBe(1);
		expect(text(first[1])).toBe(dedupedNotice("grep"));
		expect(text(second[1])).toBe(STATUS_OUTPUT);
	});

	test("a schema-owned `i` is a real input: calls differing only in it are never deduped", () => {
		// The loop records no strip for an `i` the tool's schema owns.
		const first = turn("mcp__docs__page", { doc: "guide", i: "intro" }, STATUS_OUTPUT, T0);
		const second = turn("mcp__docs__page", { doc: "guide", i: "setup" }, STATUS_OUTPUT, T0 + 1_000);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
		expect(text(second[1])).toBe(STATUS_OUTPUT);
	});

	test("a schema-owned `i` still dedupes when it repeats", () => {
		const first = turn("mcp__docs__page", { doc: "guide", i: "intro" }, STATUS_OUTPUT, T0);
		const second = turn("mcp__docs__page", { i: "intro", doc: "guide" }, STATUS_OUTPUT, T0 + 1_000);

		expect(dedupe([...first, ...second]).prunedCount).toBe(1);
		expect(text(first[1])).toBe(dedupedNotice("mcp__docs__page"));
	});

	test("an `i` its call does not record as stripped stays in the identity", () => {
		// No record: history from before the marker, or intent tracing off.
		const first = turn("grep", { pattern: "foo", path: "src", i: "look for foo" }, STATUS_OUTPUT, T0);
		const second = turn("grep", { pattern: "foo", path: "src", i: "again" }, STATUS_OUTPUT, T0 + 1_000, STRIPPED);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
	});

	test("a nested `i` is tool data even when the top-level `i` is harness intent", () => {
		const first = turn(
			"grep",
			{ pattern: "foo", path: "src", opts: { i: 1 }, i: "look" },
			STATUS_OUTPUT,
			T0,
			STRIPPED,
		);
		const second = turn(
			"grep",
			{ pattern: "foo", path: "src", opts: { i: 2 }, i: "look" },
			STATUS_OUTPUT,
			T0 + 1_000,
			STRIPPED,
		);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
	});

	test("a schema replaced mid-session never strips `i` from calls its old schema owned", async () => {
		// The MCP server first declares `i` (a page index); a `tools/list_changed`
		// then replaces the same-named tool with a schema that does not.
		const owning = agentTool("mcp__docs__page", type({ doc: "string", i: "string" }), STATUS_OUTPUT);
		const replacement = agentTool("mcp__docs__page", type({ doc: "string" }), STATUS_OUTPUT);
		const page = (id: string, i: string): ToolCall => ({
			type: "toolCall",
			id,
			name: "mcp__docs__page",
			arguments: { doc: "guide", i },
		});

		const before = await runLoop([owning], [], [page("intro", "intro"), page("setup", "setup")]);
		const history = await runLoop([replacement], before, [page("look", "look"), page("again", "again")]);
		const at = Date.now();
		const entries = history.map(message => messageEntry(message, at));
		const resultText = (id: string) =>
			text(entries.find(e => (e.message as ToolResultMessage).toolCallId === id) as SessionEntry);

		const pruned = dedupe(entries, { now: at });

		// Distinct page indexes under the owning schema stay distinct calls.
		expect(resultText("intro")).toBe(STATUS_OUTPUT);
		expect(resultText("setup")).toBe(STATUS_OUTPUT);
		// Under the replacement the loop stripped `i` as intent, so those calls match.
		expect(resultText("look")).toBe(dedupedNotice("mcp__docs__page"));
		expect(resultText("again")).toBe(STATUS_OUTPUT);
		expect(pruned.prunedCount).toBe(1);
	});

	test("different arguments are never deduped, even with identical output", () => {
		const first = turn("bash", { command: "git status" }, STATUS_OUTPUT, T0);
		const second = turn("bash", { command: "git status --long" }, STATUS_OUTPUT, T0 + 1_000);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
	});

	test("different tools with the same arguments are never deduped", () => {
		const first = turn("find", { pattern: "*.ts" }, STATUS_OUTPUT, T0);
		const second = turn("grep", { pattern: "*.ts" }, STATUS_OUTPUT, T0 + 1_000);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
	});

	test("the same call with a changed result keeps both", () => {
		const first = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0);
		const second = turn("bash", GIT_STATUS, OTHER_OUTPUT, T0 + 1_000);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
		expect(text(second[1])).toBe(OTHER_OUTPUT);
	});

	test("a same-length changed result keeps both", () => {
		const changed = STATUS_OUTPUT.replace("foo.ts", "bar.ts");
		expect(changed.length).toBe(STATUS_OUTPUT.length);
		const first = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0);
		const second = turn("bash", GIT_STATUS, changed, T0 + 1_000);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
	});

	test("an older copy matching a non-adjacent newer copy is blanked; a changed middle copy is kept", () => {
		const first = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0);
		const middle = turn("bash", GIT_STATUS, OTHER_OUTPUT, T0 + 1_000);
		const last = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + 2_000);

		expect(dedupe([...first, ...middle, ...last]).prunedCount).toBe(1);
		expect(text(first[1])).toBe(dedupedNotice("bash"));
		expect(text(middle[1])).toBe(OTHER_OUTPUT);
		expect(text(last[1])).toBe(STATUS_OUTPUT);
	});

	test("results below the token floor are left alone", () => {
		const small = "nothing to commit, working tree clean";
		expect(
			tokenizer.countMessage((turn("bash", GIT_STATUS, small, T0)[1] as SessionMessageEntry).message),
		).toBeLessThan(MIN_DEDUPE_TOKENS);
		const first = turn("bash", GIT_STATUS, small, T0);
		const second = turn("bash", GIT_STATUS, small, T0 + 1_000);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(small);
	});

	test("protected tools are never blanked", () => {
		const first = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0);
		const second = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + 1_000);

		expect(dedupe([...first, ...second], { protectedTools: ["bash"] }).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
	});

	test("spill recovery reads are never blanked", () => {
		const args = { path: "local://3.log:1-200" };
		const first = turn("read", args, STATUS_OUTPUT, T0);
		const second = turn("read", args, STATUS_OUTPUT, T0 + 1_000);

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
	});

	test("never mutates entries before the compaction boundary", () => {
		const first = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0); // before boundary
		const second = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + 1_000); // boundary at its call
		const third = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + 2_000);
		const entries = [...first, ...second, ...third];

		// Cold cache: the idle flush would rewrite the whole sent region.
		const pruned = dedupe(entries, { keepBoundaryId: second[0].id, now: T0 + 2_000 + 31 * 60_000 });

		expect(pruned.prunedCount).toBe(1);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
		expect(prunedAt(first[1])).toBeUndefined();
		expect(text(second[1])).toBe(dedupedNotice("bash"));
		expect(text(third[1])).toBe(STATUS_OUTPUT);
	});

	test("parallel duplicates within one turn are left alone", () => {
		const callA = toolCall("bash", GIT_STATUS);
		const callB = toolCall("bash", GIT_STATUS);
		const entries: SessionEntry[] = [
			assistant([callA, callB], T0),
			result(callA, STATUS_OUTPUT, T0),
			result(callB, STATUS_OUTPUT, T0),
		];

		expect(dedupe(entries).prunedCount).toBe(0);
		expect(text(entries[1])).toBe(STATUS_OUTPUT);
		expect(text(entries[2])).toBe(STATUS_OUTPUT);
	});

	test("three or more copies: every copy but the newest is blanked", () => {
		const copies = [0, 1, 2, 3].map(k => turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + k * 1_000));

		expect(dedupe(copies.flat()).prunedCount).toBe(3);
		for (const copy of copies.slice(0, 3)) expect(text(copy[1])).toBe(dedupedNotice("bash"));
		expect(text(copies[3][1])).toBe(STATUS_OUTPUT);
	});

	test("a superseded read gets only the supersede notice; already-pruned notices are never deduped", () => {
		const args = { path: "src/foo.ts" };
		const first = turn("read", args, STATUS_OUTPUT, T0);
		const second = turn("read", args, STATUS_OUTPUT, T0 + 1_000);
		const config = { supersedeKey: readToolSupersedeKey };

		expect(dedupe([...first, ...second], config).prunedCount).toBe(1);
		expect(text(first[1])).toBe(SUPERSEDED_NOTICE);
		expect(text(second[1])).toBe(STATUS_OUTPUT);

		// A later pass over the same history: the notice is not a result, so it
		// neither gets deduped nor vouches for anything.
		const third = turn("read", args, STATUS_OUTPUT, T0 + 2_000);
		expect(dedupe([...first, ...second, ...third], { now: T0 + 3_000 }).prunedCount).toBe(1);
		expect(text(first[1])).toBe(SUPERSEDED_NOTICE);
		expect(text(second[1])).toBe(dedupedNotice("read"));
		expect(text(third[1])).toBe(STATUS_OUTPUT);
	});

	test("error results are neither blanked nor references", () => {
		const first = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0);
		const second = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + 1_000);
		((second[1] as SessionMessageEntry).message as ToolResultMessage).isError = true;

		expect(dedupe([...first, ...second]).prunedCount).toBe(0);
		expect(text(first[1])).toBe(STATUS_OUTPUT);
	});

	test("disabled, identical results stay", () => {
		const first = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0);
		const second = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + 1_000);

		expect(dedupe([...first, ...second], { dedupeIdentical: false }).prunedCount).toBe(0);
	});

	test("undo restores every blanked copy", () => {
		const first = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0);
		const second = turn("bash", GIT_STATUS, STATUS_OUTPUT, T0 + 1_000);

		const pruned = dedupe([...first, ...second]);
		expect(text(first[1])).toBe(dedupedNotice("bash"));
		pruned.undo();
		expect(text(first[1])).toBe(STATUS_OUTPUT);
		expect(prunedAt(first[1])).toBeUndefined();
	});
});
