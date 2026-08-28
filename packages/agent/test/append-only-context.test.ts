import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { AppendOnlyContextManager, AppendOnlyLog, StablePrefix } from "@oh-my-pi/pi-agent-core/append-only-context";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import type { AgentContext, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message, Tool, ToolExample } from "@oh-my-pi/pi-ai";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
	return {
		systemPrompt: ["You are a helpful assistant.", "Be concise."],
		messages: [],
		tools: [],
		...overrides,
	};
}

function makeTool(
	name: string,
	description?: string,
	parameters?: Tool["parameters"],
	examples?: readonly ToolExample[],
): AgentTool {
	return {
		name,
		description: description ?? `Tool ${name}`,
		parameters: parameters ?? { type: "object", properties: {} },
		label: name,
		examples,
		execute: async () => ({ content: [{ type: "text", text: "done" }] }),
	} as AgentTool;
}

const BUILD_OPTS = { intentTracing: false } as const;

// ---------------------------------------------------------------------------
// StablePrefix
// ---------------------------------------------------------------------------

describe("StablePrefix", () => {
	it("builds and returns cached system prompt + tools", () => {
		const p = new StablePrefix();
		const ctx = makeContext({
			systemPrompt: ["You are a helpful assistant."],
			tools: [makeTool("read")],
		});

		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(true);
		expect(p.built).toBe(true);

		const { systemPrompt, tools } = p.toContext();
		expect(systemPrompt).toEqual(["You are a helpful assistant."]);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("read");
	});

	it("returns false on identical rebuild", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Hello"] });

		p.build(ctx, BUILD_OPTS);
		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(false);
	});

	it("returns true when system prompt changes", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Old prompt"] });
		p.build(ctx, BUILD_OPTS);

		const changed = p.build(makeContext({ systemPrompt: ["New prompt"] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("returns true when tools change", () => {
		const p = new StablePrefix();
		p.build(makeContext({ tools: [makeTool("read")] }), BUILD_OPTS);

		const changed = p.build(makeContext({ tools: [makeTool("read"), makeTool("write")] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("returns true when tool description changes", () => {
		const p = new StablePrefix();
		p.build(makeContext({ tools: [makeTool("read", "Original desc")] }), BUILD_OPTS);

		const changed = p.build(makeContext({ tools: [makeTool("read", "Updated desc")] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("invalidate forces rebuild", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Stable"] });
		p.build(ctx, BUILD_OPTS);

		p.invalidate();
		expect(p.built).toBe(false);

		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("toContext() throws when not built", () => {
		const p = new StablePrefix();
		expect(() => p.toContext()).toThrow("build()");
	});

	it("fingerprint changes across rebuilds", () => {
		const p = new StablePrefix();
		const ctx1 = makeContext({ systemPrompt: ["Prompt A"] });
		p.build(ctx1, BUILD_OPTS);
		const fp1 = p.fingerprint;

		const ctx2 = makeContext({ systemPrompt: ["Prompt B"] });
		p.build(ctx2, BUILD_OPTS);
		const fp2 = p.fingerprint;

		expect(fp1).not.toBe(fp2);
	});

	it("fingerprint stable for identical context", () => {
		const p = new StablePrefix();
		p.build(makeContext({ systemPrompt: ["Stable"], tools: [makeTool("foo")] }), BUILD_OPTS);
		const fp1 = p.fingerprint;

		p.build(makeContext({ systemPrompt: ["Stable"], tools: [makeTool("foo")] }), BUILD_OPTS);
		const fp2 = p.fingerprint;

		expect(fp1).toBe(fp2);
	});

	it("version increases on each rebuild", () => {
		const p = new StablePrefix();
		expect(p.version).toBe(0);

		p.build(makeContext({ systemPrompt: ["V1"] }), BUILD_OPTS);
		expect(p.version).toBe(1);

		p.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(p.version).toBe(2);

		p.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(p.version).toBe(2); // unchanged = no increment
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyLog
// ---------------------------------------------------------------------------

describe("AppendOnlyLog", () => {
	it("starts empty", () => {
		const log = new AppendOnlyLog();
		expect(log.length).toBe(0);
		expect(log.toMessages()).toEqual([]);
	});

	it("appends messages", () => {
		const log = new AppendOnlyLog();
		log.append({ role: "user", content: "hello" } as any);
		log.append({ role: "assistant", content: "world" } as any);
		expect(log.length).toBe(2);
		expect(log.toMessages()).toHaveLength(2);
	});

	it("toMessages returns a copy of the array", () => {
		const log = new AppendOnlyLog();
		const msg = { role: "user", content: "test" };
		log.append(msg);
		const msgs = log.toMessages();
		// Array is a copy — mutating it doesn't affect the log
		msgs.pop();
		expect(log.length).toBe(1);
	});

	it("replaceTail replaces last entry", () => {
		const log = new AppendOnlyLog();
		log.append({ role: "user", content: "old" });
		log.replaceTail({ role: "user", content: "new" });
		expect(log.toMessages()).toHaveLength(1);
		expect(log.toMessages()[0]!.content).toBe("new");
	});

	it("replaceTail is no-op on empty log", () => {
		const log = new AppendOnlyLog();
		log.replaceTail({ role: "user", content: "nope" });
		expect(log.length).toBe(0);
	});

	it("extend appends multiple messages", () => {
		const log = new AppendOnlyLog();
		log.extend([
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
		]);
		expect(log.length).toBe(2);
	});

	it("clear resets the log", () => {
		const log = new AppendOnlyLog();
		log.append({ role: "user", content: "x" });
		log.clear();
		expect(log.length).toBe(0);
	});

	it("entries readonly access returns internal array", () => {
		const log = new AppendOnlyLog();
		log.append({ role: "user", content: "test" });
		expect(log.entries()).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyContextManager
// ---------------------------------------------------------------------------

describe("AppendOnlyContextManager", () => {
	it("build() returns context with stable prefix on first call", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({
			systemPrompt: ["You are a bot."],
			tools: [makeTool("read")],
		});

		const result = mgr.build(ctx, BUILD_OPTS);

		expect(result.systemPrompt).toEqual(["You are a bot."]);
		expect(result.tools).toHaveLength(1);
		expect(result.messages).toEqual([]);
	});

	it("build() returns same systemPrompt and tools on subsequent calls", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({
			systemPrompt: ["Original prompt"],
			tools: [makeTool("read")],
		});

		mgr.build(ctx, BUILD_OPTS);

		// Same context — should reuse cached prefix
		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["Original prompt"]);
		expect(result.tools).toHaveLength(1);
	});

	it("build() detects changed system prompt and rebuilds", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Old"] }), BUILD_OPTS);

		const result = mgr.build(makeContext({ systemPrompt: ["New"] }), BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["New"]);
	});

	it("prefix.fingerprint changes when tools change", () => {
		const mgr = new AppendOnlyContextManager();

		mgr.build(makeContext({ tools: [makeTool("read")] }), BUILD_OPTS);
		const fp1 = mgr.prefix.fingerprint;

		mgr.build(makeContext({ tools: [makeTool("read"), makeTool("write")] }), BUILD_OPTS);
		const fp2 = mgr.prefix.fingerprint;

		expect(fp1).not.toBe(fp2);
	});

	it("appendMessage grows the log", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.appendMessage({ role: "user", content: "hello" } as any);
		mgr.appendMessage({ role: "assistant", content: "world" } as any);

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]!.role).toBe("user");
		expect(result.messages[1]!.role).toBe("assistant");
	});

	it("appendMessage messages appear in every subsequent build()", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.appendMessage({ role: "user", content: "q1" });
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);

		mgr.appendMessage({ role: "assistant", content: "a1" });
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("a1");
	});

	it("invalidate forces prefix rebuild", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["V1"] }), BUILD_OPTS);

		mgr.invalidate();
		const result = mgr.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["V2"]);
	});

	it("reset clears log and prefix", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Original"] }), BUILD_OPTS);
		mgr.appendMessage({ role: "user", content: "hello" });

		const freshCtx = makeContext({ systemPrompt: ["Fresh start"] });
		mgr.reset(freshCtx, BUILD_OPTS);

		const result = mgr.build(freshCtx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["Fresh start"]);
		expect(result.messages).toHaveLength(0);
	});

	it("replaceTailMessage updates last log entry", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.appendMessage({ role: "user", content: "old" });
		mgr.replaceTailMessage({ role: "user", content: "new" });

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.content).toBe("new");
	});

	it("build propagates tool spec description default", () => {
		const mgr = new AppendOnlyContextManager();
		const toolWithNoDesc = makeTool("bare");
		delete (toolWithNoDesc as any).description;

		const ctx = makeContext({ tools: [toolWithNoDesc] });
		const result = mgr.build(ctx, BUILD_OPTS);

		const tool: Tool | undefined = result.tools?.[0];
		expect(tool).toBeDefined();
		expect(tool!.description).toBe("");
	});

	it("tools returned from build are frozen in the cache", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: [makeTool("read")] });

		const r1 = mgr.build(ctx, BUILD_OPTS);
		const r2 = mgr.build(ctx, BUILD_OPTS);

		expect(r1.tools).toHaveLength(1);
		expect(r2.tools).toHaveLength(1);
		// Same name, same structure
		expect(r1.tools![0]!.name).toBe(r2.tools![0]!.name);
	});

	it("tolerates context with no tools", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: undefined as any });

		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.tools).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Fingerprint determinism
// ---------------------------------------------------------------------------

describe("fingerprint determinism", () => {
	it("identical context produces identical fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		const ctx = makeContext({
			systemPrompt: ["Rule 1", "Rule 2"],
			tools: [makeTool("read", "Read files"), makeTool("edit", "Edit files")],
		});

		p1.build(ctx, BUILD_OPTS);
		p2.build(ctx, BUILD_OPTS);

		expect(p1.fingerprint).toBe(p2.fingerprint);
	});

	it("tool order changes fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		const tools = [makeTool("a", "Tool A"), makeTool("b", "Tool B")];
		p1.build(makeContext({ tools }), BUILD_OPTS);

		// Create a context where tool b has "Tool B" too
		// so the fingerprint changes with name order
		const otherTools = [makeTool("b", "Tool B"), makeTool("a", "Tool A")];
		p2.build(makeContext({ tools: otherTools }), BUILD_OPTS);

		expect(p1.fingerprint).not.toBe(p2.fingerprint);
	});

	it("system prompt array structure changes fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		// ["A", "B"] and ["A\nB"] have the same joined text but different
		// array structure — must produce different fingerprints.
		p1.build(makeContext({ systemPrompt: ["A", "B"] }), BUILD_OPTS);
		p2.build(makeContext({ systemPrompt: ["A\nB"] }), BUILD_OPTS);

		expect(p1.fingerprint).not.toBe(p2.fingerprint);
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyLog message sync
// ---------------------------------------------------------------------------

describe("message sync", () => {
	it("syncMessages on first call appends all messages", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const msgs: Message[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
		] as any;
		mgr.syncMessages(msgs);

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]!.content).toBe("Hello");
		expect(result.messages[1]!.content).toBe("Hi");
	});

	it("syncMessages on subsequent calls only appends delta", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([{ role: "user", content: "q1" }]);
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		]);
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("a1");
	});

	it("syncMessages with unchanged messages is a no-op (same length, no new entries)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([{ role: "user", content: "q1" }]);

		const before = mgr.log.length;

		// Same array length → nothing new to append
		mgr.syncMessages([{ role: "user", content: "q1" }]);
		expect(mgr.log.length).toBe(before);
	});

	it("syncMessages resets log when array shrinks (compaction)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "q2" },
		]);
		expect(mgr.log.length).toBe(3);

		// Simulate compaction — array shrinks
		mgr.syncMessages([{ role: "user", content: "q2" }]);
		expect(mgr.log.length).toBe(1);
		expect(mgr.log.toMessages()[0]!.content).toBe("q2");
	});

	it("build + syncMessages integration: messages come from log, not from context.messages", () => {
		const mgr = new AppendOnlyContextManager();

		// First turn: build with empty context, sync first message
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([{ role: "user", content: "turn1" }]);
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);
		expect(r1.messages[0]!.content).toBe("turn1");

		// Second turn: sync second message
		mgr.syncMessages([
			{ role: "user", content: "turn1" },
			{ role: "assistant", content: "resp1" },
		]);
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("resp1");
	});

	it("resetSyncCursor forces full re-sync on next call", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([{ role: "user", content: "old" }]);

		mgr.resetSyncCursor();
		mgr.syncMessages([{ role: "user", content: "fresh" }]);

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.content).toBe("fresh");
	});

	it("preserves the byte-stable prefix when a deep message is rewritten (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = { role: "user", content: "q1" } as any;
		const original1 = { role: "assistant", content: "original long result" } as any;
		mgr.syncMessages([original0, original1]);
		expect(mgr.log.length).toBe(2);

		// Same length, but the second message's content changed (simulates per-turn
		// tool-output pruning / transformContext re-render).
		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "[pruned]" },
		] as any);
		expect(mgr.log.length).toBe(2);

		const entries = mgr.log.entries();
		// The first message MUST keep its on-the-wire identity — that's what
		// stops llama.cpp from re-prefilling the entire prior context.
		expect(entries[0]).toBe(original0);
		// The diverged tail is re-synced with the new bytes.
		expect((entries[1] as { content: unknown }).content).toBe("[pruned]");
	});

	it("detects tool-result metadata-only rewrites before preserving a later prefix (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = { role: "user", content: "q1" } as any;
		const original1 = {
			role: "toolResult",
			content: [{ type: "text", text: "same output" }],
			toolCallId: "old-call",
			toolName: "read",
			isError: false,
		} as any;
		const original2 = { role: "assistant", content: "a1" } as any;
		mgr.syncMessages([original0, original1, original2]);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{
				role: "toolResult",
				content: [{ type: "text", text: "same output" }],
				toolCallId: "new-call",
				toolName: "write",
				isError: true,
			},
			{ role: "assistant", content: "a1-pruned" },
		] as any);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(original0);
		expect((entries[1] as { toolCallId: unknown }).toolCallId).toBe("new-call");
		expect((entries[1] as { toolName: unknown }).toolName).toBe("write");
		expect((entries[1] as { isError: unknown }).isError).toBe(true);
		expect((entries[2] as { content: unknown }).content).toBe("a1-pruned");
	});

	it("detects providerPayload-only rewrites before preserving a later prefix (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = { role: "user", content: "q1" } as any;
		const original1 = {
			role: "assistant",
			content: [{ type: "text", text: "same visible output" }],
			id: "assistant-1",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "old native" }] }],
			},
		} as any;
		const original2 = { role: "user", content: "q2" } as any;
		mgr.syncMessages([original0, original1, original2]);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{
				role: "assistant",
				content: [{ type: "text", text: "same visible output" }],
				id: "assistant-1",
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "openai",
					items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "new native" }] }],
				},
			},
			{ role: "user", content: "q2-rewritten" },
		] as any);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(original0);
		expect(
			(entries[1] as { providerPayload?: { items?: Array<{ content?: Array<{ text?: string }> }> } }).providerPayload
				?.items?.[0]?.content?.[0]?.text,
		).toBe("new native");
		expect((entries[2] as { content: unknown }).content).toBe("q2-rewritten");
	});

	it("does not reuse a stable prefix longer than the current log after direct log clear (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		] as any);
		expect(mgr.log.length).toBe(2);

		// Public log clear used by advisor reset: it intentionally empties the
		// provider-bound message log but does not touch the private sync cursor.
		mgr.log.clear();
		expect(mgr.log.length).toBe(0);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1-rewritten" },
		] as any);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(2);
		expect((entries[0] as { content: unknown }).content).toBe("q1");
		expect((entries[1] as { content: unknown }).content).toBe("a1-rewritten");
	});

	it("preserves the prefix when the tail is rewritten (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = { role: "user", content: "q1" } as any;
		const original1 = { role: "assistant", content: "a1" } as any;
		const original2 = { role: "user", content: "q2" } as any;
		mgr.syncMessages([original0, original1, original2]);

		// Tail-only rewrite (e.g. per-turn pruning of the most recent tool result):
		// the first two messages MUST stay byte-stable; only the tail re-syncs.
		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "q2-rewritten" },
		] as any);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(original0);
		expect(entries[1]).toBe(original1);
		expect((entries[2] as { content: unknown }).content).toBe("q2-rewritten");
	});

	it("appended new messages keep the prefix stable even when the prior tail also diverged (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = { role: "user", content: "q1" } as any;
		const original1 = { role: "assistant", content: "a1" } as any;
		mgr.syncMessages([original0, original1]);

		// Re-sync with: (a) message #1 rewritten in place; (b) a brand-new tail
		// appended. The prefix [original0] MUST stay byte-stable.
		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1-pruned" },
			{ role: "user", content: "q2" },
		] as any);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(original0);
		expect((entries[1] as { content: unknown }).content).toBe("a1-pruned");
		expect((entries[2] as { content: unknown }).content).toBe("q2");
	});

	it("rewriting the first message still re-syncs from scratch", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([{ role: "user", content: "hello" }]);
		expect(mgr.log.length).toBe(1);

		// No byte-stable prefix — the only message diverged.
		mgr.syncMessages([{ role: "user", content: "world" }]);

		const msgs = mgr.build(makeContext(), BUILD_OPTS).messages;
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.content).toBe("world");
	});

	it("no-op when content unchanged", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		]);

		const before = mgr.log.length;
		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		]);
		// Length unchanged — no new messages appended, no clear
		expect(mgr.log.length).toBe(before);
	});

	it("invalidateForModelChange resets prefix and log", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Before"] }), BUILD_OPTS);
		mgr.syncMessages([{ role: "user", content: "hello" }]);

		mgr.invalidateForModelChange();

		// Should need a fresh build — prefix was invalidated
		const ctx = makeContext({ systemPrompt: ["After"] });
		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["After"]);
		expect(result.messages).toHaveLength(0);

		// Re-sync should work cleanly
		mgr.syncMessages([{ role: "user", content: "new turn" }]);
		const r2 = mgr.build(ctx, BUILD_OPTS);
		expect(r2.messages).toHaveLength(1);
		expect(r2.messages[0]!.content).toBe("new turn");
	});
	it("keeps sync decisions byte-faithful across steady-state, growth, rewrite, and revert", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		// Partial message literals — syncMessages digests structural fields only.
		const msgs: Message[] = [];
		for (let i = 0; i < 4; i++) {
			msgs.push({ role: "user", content: `q${i}` } as unknown as Message);
			msgs.push({ role: "assistant", content: `a${i}` } as unknown as Message);
		}
		mgr.syncMessages(msgs);
		expect([...mgr.log.entries()]).toEqual(msgs);

		// Steady state: the pipeline hands back the same converted objects every
		// call; the on-the-wire history must not move.
		mgr.syncMessages(msgs);
		expect([...mgr.log.entries()]).toEqual(msgs);

		// Growth: prefix entries keep their identity, only the tail is added.
		const before = [...mgr.log.entries()];
		const tail = { role: "assistant", content: "new turn" } as unknown as Message;
		msgs.push(tail);
		mgr.syncMessages(msgs);
		let entries = mgr.log.entries();
		expect(entries.length).toBe(msgs.length);
		expect(entries[entries.length - 1]).toBe(tail);
		for (let i = 0; i < before.length; i++) expect(entries[i]).toBe(before[i]);

		// Rewrite: one message's bytes change (fresh fragment objects); the log
		// keeps the byte-stable prefix and replaces everything from the change.
		const split = 5;
		const rewritten = msgs.map((m, i) =>
			i === split ? ({ role: m.role, content: "[pruned]" } as unknown as Message) : m,
		);
		mgr.syncMessages(rewritten);
		entries = mgr.log.entries();
		for (let i = 0; i < split; i++) expect(entries[i]).toBe(before[i]);
		for (let i = split; i < rewritten.length; i++) expect(entries[i]).toBe(rewritten[i]);

		// Revert: the original bytes return as fresh objects; the wire must show
		// exactly those bytes again, in order.
		const reverted = structuredClone(rewritten);
		reverted[split] = { role: "assistant", content: "a2" } as unknown as Message;
		mgr.syncMessages(reverted);
		expect([...mgr.log.entries()]).toEqual(reverted);
		const built = mgr.build(makeContext(), BUILD_OPTS);
		expect(built.messages).toEqual(reverted);
	});

	it("re-syncs an in-place rewritten message once invalidation bumps its version", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const raw = { role: "assistant", content: [{ type: "text", text: "original" }] };
		const msg = raw as unknown as Message;
		mgr.syncMessages([msg]);
		expect(mgr.log.entries()[0]).toBe(msg);

		// Owner-side in-place rewrite under stable identity (prune/shake/
		// strip-images seam): the log aliases the very object being mutated, so
		// the memo must not keep serving pre-mutation bytes.
		raw.content = [{ type: "text", text: "[redacted]" }];
		invalidateMessageCache(msg);
		mgr.syncMessages([msg]);
		expect(mgr.log.entries()[0]).toBe(msg);

		// A later replay restores the ORIGINAL bytes as a fresh object. The
		// manager must diverge here and put the replayed bytes on the wire —
		// not the stale aliased object whose digest matched the old bytes.
		const reverted = {
			role: "assistant",
			content: [{ type: "text", text: "original" }],
		} as unknown as Message;
		mgr.syncMessages([reverted]);
		const built = mgr.build(makeContext(), BUILD_OPTS);
		expect(built.messages[0]).toBe(reverted);
		expect(built.messages[0]!.content).toEqual([{ type: "text", text: "original" }]);
	});

	it("treats fresh-object clones with identical bytes as stable and still detects real rewrites", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const originals = [
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		] as unknown as Message[];
		mgr.syncMessages(originals);

		// Every call can re-normalize history into fresh objects (cerebras
		// thinking-strip, transformContext re-render); identical bytes must keep
		// the on-the-wire prefix objects stable.
		const clones = structuredClone(originals);
		mgr.syncMessages(clones);
		let entries = mgr.log.entries();
		expect(entries[0]).toBe(originals[0]);
		expect(entries[1]).toBe(originals[1]);

		// A real byte rewrite reaches sync as fresh fragment objects (owner
		// invalidation recomputes the cached conversion) and must still diverge
		// at exactly the changed message.
		const rewritten = structuredClone(originals);
		rewritten[1].content = "[pruned]";
		mgr.syncMessages(rewritten);
		entries = mgr.log.entries();
		expect(entries[0]).toBe(originals[0]);
		expect(entries[1]).toBe(rewritten[1]);
	});
});

// ---------------------------------------------------------------------------
// Intent injection
// ---------------------------------------------------------------------------

describe("intent injection through build()", () => {
	it("injects required `i` into tool schemas when intentTracing is true", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("read", "Read", {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(params?.properties).toBeDefined();
		expect(params!.properties![INTENT_FIELD]).toBeDefined();
		expect(params!.required).toContain(INTENT_FIELD);
	});

	it("materializes ArkType params and keeps `i` first in authored order", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("write", "Write", type({ path: "string", content: "string" }));
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		// `i` must lead; authored order (path before content) is preserved rather
		// than ArkType's alphabetized-by-hash order (content, path).
		expect(Object.keys(params.properties ?? {})).toEqual([INTENT_FIELD, "path", "content"]);
		expect(params.required).toContain(INTENT_FIELD);
	});

	it("omits `i` when intentTracing is false", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("read", "Read", {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: false });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(params?.properties?.[INTENT_FIELD]).toBeUndefined();
		expect(params?.required ?? []).not.toContain(INTENT_FIELD);
	});

	it("intentTracing flip invalidates the fingerprint cache", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: [makeTool("read")] });

		mgr.build(ctx, { intentTracing: false });
		const fpNoIntent = mgr.prefix.fingerprint;

		mgr.build(ctx, { intentTracing: true });
		const fpWithIntent = mgr.prefix.fingerprint;

		expect(fpNoIntent).not.toBe(fpWithIntent);
	});
});

describe("tool examples injection through build()", () => {
	const findExamples: readonly ToolExample[] = [{ caption: "Find files", call: { paths: ["src/**/*.ts"] } }];
	const findParams = {
		type: "object",
		properties: { paths: { type: "array", items: { type: "string" } } },
	};

	it("always injects Python-syntax examples", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", findParams, findExamples);
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: false });
		const desc = result.tools?.[0]?.description ?? "";
		expect(desc).toContain("<examples>");
		expect(desc).toContain("# Find files");
		expect(desc).toContain('find(paths=["src/**/*.ts"])');
	});

	it("injects the `i` placeholder into examples when intentTracing is on", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", findParams, findExamples);
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true });
		const desc = result.tools?.[0]?.description ?? "";
		expect(desc).toContain(`${INTENT_FIELD}="…"`);
	});

	it("examples presence flip invalidates the fingerprint cache", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx1 = makeContext({ tools: [makeTool("find", "Find files.", undefined, undefined)] });
		const ctx2 = makeContext({ tools: [makeTool("find", "Find files.", undefined, findExamples)] });

		mgr.build(ctx1, { intentTracing: false });
		const fpNoExamples = mgr.prefix.fingerprint;

		mgr.invalidate();
		mgr.build(ctx2, { intentTracing: false });
		const fpWithExamples = mgr.prefix.fingerprint;

		expect(fpNoExamples).not.toBe(fpWithExamples);
	});
});

// ---------------------------------------------------------------------------
// Tool-call mutation detection
// ---------------------------------------------------------------------------

describe("syncMessages detects tool_calls mutation", () => {
	it("rebuilds the log when tool_calls is mutated in place", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const assistant: Record<string, unknown> = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/a"}' } }],
		};
		const msgs = [{ role: "user", content: "q" }, assistant] as unknown as Message[];
		mgr.syncMessages(msgs);
		expect(mgr.log.length).toBe(2);

		// Mutate tool_calls in place — role+content unchanged, so the old
		// (role+content-only) digest would miss this. The full digest must catch it.
		const tcs = assistant.tool_calls as Array<{ function: { arguments: string } }>;
		tcs[0].function.arguments = '{"path":"/b"}';
		mgr.syncMessages(msgs);

		// Log was rebuilt → length resets to the new normalized message list length.
		expect(mgr.log.length).toBe(2);
		const rebuilt = mgr.log.toMessages()[1] as unknown as Record<string, unknown>;
		const rebuiltTc = (rebuilt.tool_calls as Array<{ function: { arguments: string } }>)[0];
		expect(rebuiltTc.function.arguments).toBe('{"path":"/b"}');
	});
});
