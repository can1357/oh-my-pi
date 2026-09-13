import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	agentLoop,
	type SpeculativeOperationSink,
	type SpeculativePhysicalOutcome,
} from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as jsContextManager from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { EvalShadowCellSession } from "@oh-my-pi/pi-coding-agent/eval/speculation/cell-session";
import { CodingAgentSpeculativeExecutionHost } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];
const pythonIt = process.env.PI_PYTHON_INTEGRATION === "1" ? it : it.skip;

afterEach(async () => {
	vi.restoreAllMocks();
	await jsContextManager.disposeAllVmContexts();
	await disposeAllKernelSessions();
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function eraseToolSchema(tool: ReadTool): AgentTool {
	return tool as AgentTool;
}

describe("streamed eval speculation", () => {
	it("claims a JavaScript read started before the outer eval call finishes streaming", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "speculative content");
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"images.autoResize": false,
			"tools.speculativeExecution.enabled": true,
		});
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);

		const warm = await evalTool.execute("warm", { language: "js", code: "globalThis.shadowWarm = true" });
		expect(warm.isError).not.toBe(true);

		const finalized = read.speculation.finalized;
		if (!finalized) throw new Error("read tool has no finalized speculation policy");
		const executeRead = finalized.execute;
		const started = Promise.withResolvers<void>();
		let executions = 0;
		let providerDone = false;
		let startedBeforeProviderDone = false;
		finalized.execute = async (context, signal) => {
			executions += 1;
			startedBeforeProviderDone = !providerDone;
			started.resolve();
			return await executeRead(context, signal);
		};

		const host = new CodingAgentSpeculativeExecutionHost(settings, session, { hasHandlers: () => false });
		const mock = createMockModel({ responses: [] });
		const args = {
			language: "js",
			code: 'await tool.read({ path: "note.txt" })',
		};
		let turn = 0;
		const streamFn = (_model: unknown, _context: Context) => {
			const response = new AssistantMessageEventStream();
			void (async () => {
				if (turn++ === 0) {
					const streamingCall = { type: "toolCall" as const, id: "eval-1", name: "eval", arguments: {} };
					setStreamingPartialJson(streamingCall, JSON.stringify(args));
					const streamingPartial = assistant([streamingCall], "toolUse");
					const toolCall = { ...streamingCall, arguments: args };
					const finalPartial = assistant([toolCall], "toolUse");
					response.push({ type: "start", partial: streamingPartial });
					response.push({ type: "toolcall_start", contentIndex: 0, partial: streamingPartial });
					response.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(args),
						partial: streamingPartial,
					});
					await started.promise;
					response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: finalPartial });
					providerDone = true;
					response.push({ type: "done", reason: "toolUse", message: finalPartial });
					return;
				}
				const partial = assistant([{ type: "text", text: "done" }], "stop");
				response.push({ type: "start", partial });
				response.push({ type: "done", reason: "stop", message: partial });
			})();
			return response;
		};

		const messages = await agentLoop(
			[{ role: "user", content: "Read the note", timestamp: Date.now() }],
			{ systemPrompt: [""], messages: [], tools: [evalTool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				speculativeToolExecution: { enabled: true, host },
			},
			undefined,
			streamFn,
		).result();

		expect(startedBeforeProviderDone).toBe(true);
		expect(executions).toBe(1);
		expect(messages.filter(message => message.role === "toolResult")).toHaveLength(1);
	});

	it("does not admit calls from unresolved control-flow branches", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-control-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-control-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-control", { language: "js", code: "globalThis.shadowWarm = true" });
		const admitted: string[] = [];
		const coordinator: SpeculativeOperationSink = {
			maxInFlight: 2,
			async admit(definition) {
				admitted.push(definition.candidateId);
				return undefined;
			},
			close() {},
		};
		const shadow = new EvalShadowCellSession({
			coordinator,
			parentToolCallId: "eval-control",
			session,
			cwd: directory,
			sessionId: "speculative-eval-control-test",
		});
		const args = {
			language: "js",
			code: [
				'let selected = "first.txt";',
				'if (unknownCondition) selected = "second.txt"; else selected = "third.txt";',
				"await tool.read({ path: selected });",
			].join("\n"),
		};
		const toolCall = { type: "toolCall" as const, id: "eval-control", name: "eval", arguments: args };

		shadow.update(toolCall, JSON.stringify(args));
		await shadow.finalize({ args });

		expect(admitted).toEqual([]);
		await shadow.discard("test complete");
	});

	it("discards admissions the final eval code invalidates", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-final-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-final-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-final", { language: "js", code: "globalThis.shadowWarm = true" });
		const admitted: string[] = [];
		const discarded: string[] = [];
		const coordinator: SpeculativeOperationSink = {
			maxInFlight: 2,
			async admit(definition) {
				admitted.push(definition.candidateId);
				return undefined;
			},
			async discardChildren(parentToolCallId: string, reason: string) {
				discarded.push(`${parentToolCallId}:${reason}`);
			},
			close() {},
		};
		const prefixCode = 'await tool.read({ path: "note.txt" })';
		const prefixArgs = { language: "js", code: prefixCode };
		const shadow = new EvalShadowCellSession({
			coordinator,
			parentToolCallId: "eval-final",
			session,
			cwd: directory,
			sessionId: "speculative-eval-final-test",
		});
		const toolCall = { type: "toolCall" as const, id: "eval-final", name: "eval", arguments: prefixArgs };
		shadow.update(toolCall, JSON.stringify(prefixArgs));
		// The final cell appends a hoisted `tool` shadow after the read streamed:
		// matchesFinal still accepts (cumulative prefix), but the final plan no
		// longer contains the admitted operation, so finalize must discard before
		// the authoritative cell can claim it.
		const finalArgs = { language: "js", code: `${prefixCode}\nfunction tool() {}` };
		await shadow.finalize({ args: finalArgs });
		expect(admitted).toHaveLength(1);
		expect(discarded).toHaveLength(1);
		expect(discarded[0]).toContain("eval-final");
		await shadow.discard("test complete");
	});

	it("keeps admissions the final eval code still contains", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-final-keep-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-final-keep-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-final-keep", { language: "js", code: "globalThis.shadowWarm = true" });
		const admitted: string[] = [];
		const discarded: string[] = [];
		const coordinator: SpeculativeOperationSink = {
			maxInFlight: 2,
			async admit(definition) {
				admitted.push(definition.candidateId);
				return undefined;
			},
			async discardChildren(parentToolCallId: string, reason: string) {
				discarded.push(`${parentToolCallId}:${reason}`);
			},
			close() {},
		};
		const args = { language: "js", code: 'await tool.read({ path: "note.txt" })' };
		const shadow = new EvalShadowCellSession({
			coordinator,
			parentToolCallId: "eval-final-keep",
			session,
			cwd: directory,
			sessionId: "speculative-eval-final-keep-test",
		});
		const toolCall = { type: "toolCall" as const, id: "eval-final-keep", name: "eval", arguments: args };
		shadow.update(toolCall, JSON.stringify(args));
		await shadow.finalize({ args });
		expect(admitted).toHaveLength(1);
		expect(discarded).toEqual([]);
		await shadow.discard("test complete");
	});

	it("discards the shadow session when retained state changes before dispatch", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-dispatch-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "a.txt"), "stale content");
		await fs.writeFile(path.join(directory, "b.txt"), "fresh content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-dispatch-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-dispatch", { language: "js", code: 'globalThis.target = "a.txt"' });
		const admitted: string[] = [];
		const discarded: string[] = [];
		const coordinator: SpeculativeOperationSink = {
			maxInFlight: 2,
			async admit(definition) {
				admitted.push(definition.candidateId);
				return undefined;
			},
			async discardChildren(parentToolCallId: string, reason: string) {
				discarded.push(`${parentToolCallId}:${reason}`);
			},
			close() {},
		};
		const stream = evalTool.speculation.stream;
		if (!stream?.open) throw new Error("eval tool has no speculation stream policy");
		const cell = await stream.open({ coordinator, parentToolCallId: "eval-dispatch" });
		if (!cell) throw new Error("expected a shadow cell session");
		const args = { language: "js" as const, code: "await tool.read({ path: target })" };
		const toolCall = { type: "toolCall" as const, id: "eval-dispatch", name: "eval", arguments: args };
		cell.update(toolCall, JSON.stringify(args));
		await cell.finalize({ args, toolCall });
		expect(admitted).toHaveLength(1);
		// Another retained cell mutates the namespace after planning.
		const mutation = await evalTool.execute("mutate-dispatch", {
			language: "js",
			code: 'globalThis.target = "b.txt"',
		});
		expect(mutation.isError).not.toBe(true);
		// Dispatch must drop the stale speculative child and run the cell
		// ordinarily against current state instead of claiming it.
		const result = await evalTool.execute("eval-dispatch", args);
		expect(result.isError).not.toBe(true);
		expect(discarded.length).toBeGreaterThan(0);
		const text = result.content?.find(entry => entry.type === "text")?.text ?? "";
		expect(text).toContain("fresh content");
		expect(text).not.toContain("stale content");
	});

	it("derives dependent arguments from committed results", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-committed-"));
		temporaryDirectories.push(directory);
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-committed-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-committed", { language: "js", code: "globalThis.shadowWarm = true" });
		// The commit policy transforms the physical result: dependents admitted
		// from the pre-commit value would speculatively read arguments the
		// authoritative cell never uses.
		const physical: AgentToolResult<unknown> = { content: [{ type: "text", text: "b" }] };
		const committed: AgentToolResult<unknown> = { content: [{ type: "text", text: "COMMITTED" }] };
		const admitted: Array<{ candidateId: string; args: unknown }> = [];
		const secondAdmission = Promise.withResolvers<void>();
		const coordinator: SpeculativeOperationSink = {
			maxInFlight: 2,
			async admit(definition) {
				admitted.push({ candidateId: definition.candidateId, args: definition.toolCall.arguments });
				if (admitted.length === 2) secondAdmission.resolve();
				return {
					candidateId: definition.candidateId,
					fingerprint: "test-fingerprint",
					effect: { kind: "pure" },
					outcome: Promise.resolve({ kind: "result", result: physical, isError: false }),
					commit: async () => committed,
					discard: async () => {},
				};
			},
			close() {},
		};
		const code = 'const a = await tool.read({ path: "a.txt" });\nawait tool.read({ path: a + ".txt" });';
		const args = { language: "js", code };
		const shadow = new EvalShadowCellSession({
			coordinator,
			parentToolCallId: "eval-committed",
			session,
			cwd: directory,
			sessionId: "speculative-eval-committed-test",
		});
		const toolCall = { type: "toolCall" as const, id: "eval-committed", name: "eval", arguments: args };
		shadow.update(toolCall, JSON.stringify(args));
		await shadow.finalize({ args });
		// No committed parent result exists yet, so the dependent stays unadmitted.
		expect(admitted).toHaveLength(1);
		// Claiming the parent commits (transforming) its result; the dependent is
		// admitted afterwards, against the committed value.
		const claimed = await shadow.claim(
			"read",
			{ path: "a.txt" },
			{ siteId: "js:16", occurrence: 0 },
			Number.MAX_SAFE_INTEGER,
		);
		expect(claimed).toBeDefined();
		await secondAdmission.promise;
		expect(admitted).toHaveLength(2);
		expect(admitted[1]?.args).toMatchObject({ path: "COMMITTED.txt" });
		await shadow.discard("test complete");
	});
	it("rejects appended source at reconcile even when the prefix matches", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-appended-"));
		temporaryDirectories.push(directory);
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-appended-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-appended", { language: "js", code: "globalThis.shadowWarm = true" });
		const coordinator: SpeculativeOperationSink = {
			maxInFlight: 2,
			async admit() {
				return undefined;
			},
			close() {},
		};
		const code = 'await tool.read({ path: "a.txt" });';
		const args = { language: "js", code };
		const shadow = new EvalShadowCellSession({
			coordinator,
			parentToolCallId: "eval-appended",
			session,
			cwd: directory,
			sessionId: "speculative-eval-appended-test",
		});
		const toolCall = { type: "toolCall" as const, id: "eval-appended", name: "eval", arguments: args };
		shadow.update(toolCall, JSON.stringify(args));
		await shadow.finalize({ args });
		// Identical arguments still match the verified plan.
		expect(shadow.matchesFinalArgs(args)).toBe(true);
		// Appended source keeps the streamed prefix but was never verified:
		// a hoisted shadow here would invalidate the projected read.
		expect(shadow.matchesFinalArgs({ language: "js", code: `${code}\nvar tool = {};` })).toBe(false);
		await shadow.discard("test complete");
	});

	it("namespaces child tool-call IDs across outer eval calls", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-child-ids-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-child-id-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-child-ids", { language: "js", code: "globalThis.shadowWarm = true" });
		const admitted: Array<{ candidateId: string; toolCallId: string }> = [];
		const coordinator: SpeculativeOperationSink = {
			maxInFlight: 2,
			async admit(definition) {
				admitted.push({ candidateId: definition.candidateId, toolCallId: definition.toolCall.id });
				return undefined;
			},
			close() {},
		};
		const args = { language: "js", code: 'tool.read({ path: "note.txt" })' };

		for (const parentToolCallId of ["eval-first", "eval-second"]) {
			const shadow = new EvalShadowCellSession({
				coordinator,
				parentToolCallId,
				session,
				cwd: directory,
				sessionId: "speculative-eval-child-id-test",
			});
			const toolCall = { type: "toolCall" as const, id: parentToolCallId, name: "eval", arguments: args };
			shadow.update(toolCall, JSON.stringify(args));
			await shadow.finalize({ args });
			await shadow.discard("test complete");
		}

		expect(admitted).toHaveLength(2);
		expect(admitted.map(entry => entry.toolCallId)).toEqual(admitted.map(entry => entry.candidateId));
		expect(new Set(admitted.map(entry => entry.toolCallId)).size).toBe(2);
		expect(admitted[0]?.toolCallId.startsWith("eval-first:")).toBe(true);
		expect(admitted[1]?.toolCallId.startsWith("eval-second:")).toBe(true);
	});

	it("falls back immediately when shadow admission is denied", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-denied-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-denied-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-denied", { language: "js", code: "globalThis.shadowWarm = true" });
		const shadow = new EvalShadowCellSession({
			coordinator: {
				maxInFlight: 2,
				async admit() {
					return undefined;
				},
				close() {},
			},
			parentToolCallId: "eval-denied",
			session,
			cwd: directory,
			sessionId: "speculative-eval-denied-test",
		});
		const args = { language: "js", code: 'tool.read({ path: "note.txt" })' };
		const toolCall = { type: "toolCall" as const, id: "eval-denied", name: "eval", arguments: args };

		shadow.update(toolCall, JSON.stringify(args));
		await shadow.finalize({ args });

		await expect(
			shadow.claim("read", { path: "note.txt" }, { siteId: "js:0", occurrence: 0 }, Number.MAX_SAFE_INTEGER),
		).resolves.toBeUndefined();
		await shadow.discard("test complete");
	});

	it("aborts admitted work before waiting for shadow teardown", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-discard-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-discard-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-discard", { language: "js", code: "globalThis.shadowWarm = true" });
		const outcome = Promise.withResolvers<SpeculativePhysicalOutcome>();
		const admitted = Promise.withResolvers<void>();
		let discarded = false;
		const shadow = new EvalShadowCellSession({
			coordinator: {
				maxInFlight: 2,
				async admit(definition) {
					admitted.resolve();
					return {
						candidateId: definition.candidateId,
						fingerprint: "test",
						effect: { kind: "pure" },
						outcome: outcome.promise,
						async commit() {
							return undefined;
						},
						async discard() {},
					};
				},
				close() {
					outcome.resolve({
						kind: "result",
						result: { content: [{ type: "text", text: "discarded" }] },
						isError: false,
					});
				},
			},
			parentToolCallId: "eval-discard",
			session,
			cwd: directory,
			sessionId: "speculative-eval-discard-test",
			onDiscard: () => {
				discarded = true;
			},
		});
		const args = { language: "js", code: 'tool.read({ path: "note.txt" })' };
		const toolCall = { type: "toolCall" as const, id: "eval-discard", name: "eval", arguments: args };

		shadow.update(toolCall, JSON.stringify(args));
		await shadow.finalize({ args });
		await admitted.promise;

		await expect(
			Promise.race([shadow.discard("test complete").then(() => "done"), Bun.sleep(100).then(() => "timed-out")]),
		).resolves.toBe("done");
		expect(discarded).toBe(true);
	});

	it("discards admissions projected from a replaced provider argument buffer", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-restart-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-restart-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-restart", { language: "js", code: "globalThis.shadowWarm = true" });
		const outcome = Promise.withResolvers<SpeculativePhysicalOutcome>();
		const admitted = Promise.withResolvers<void>();
		const closeReasons: string[] = [];
		let admissionCount = 0;
		let committed = false;
		const shadow = new EvalShadowCellSession({
			coordinator: {
				maxInFlight: 2,
				async admit(definition) {
					admissionCount++;
					admitted.resolve();
					return {
						candidateId: definition.candidateId,
						fingerprint: "test",
						effect: { kind: "pure" },
						outcome: outcome.promise,
						async commit() {
							committed = true;
							return undefined;
						},
						async discard() {},
					};
				},
				close(reason) {
					closeReasons.push(reason);
					outcome.resolve({
						kind: "result",
						result: { content: [{ type: "text", text: "discarded" }] },
						isError: false,
					});
				},
			},
			parentToolCallId: "eval-restart",
			session,
			cwd: directory,
			sessionId: "speculative-eval-restart-test",
		});
		const initialArgs = { language: "js", code: 'tool.read({ path: "note.txt" })' };
		const initialCall = {
			type: "toolCall" as const,
			id: "eval-restart",
			name: "eval",
			arguments: initialArgs,
		};

		await shadow.update(initialCall, JSON.stringify(initialArgs));
		await admitted.promise;
		const replacementArgs = { language: "js", code: "42" };
		await shadow.update({ ...initialCall, arguments: replacementArgs }, JSON.stringify(replacementArgs));

		expect(closeReasons).toEqual(["streamed eval argument buffer restarted"]);
		expect(admissionCount).toBe(1);
		expect(committed).toBe(false);
	});

	it("coalesces streamed shadow plans to the newest pending prefix", async () => {
		const plannedCodes: string[] = [];
		const firstPlan = Promise.withResolvers<jsContextManager.JavaScriptShadowPlanningResult | null>();
		vi.spyOn(jsContextManager, "shadowPlanIfPresent").mockImplementation(options => {
			plannedCodes.push(options.code);
			return plannedCodes.length === 1 ? firstPlan.promise : Promise.resolve(null);
		});
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({}),
		} satisfies ToolSession;
		const shadow = new EvalShadowCellSession({
			coordinator: {
				maxInFlight: 2,
				admit: async () => undefined,
				close() {},
			},
			parentToolCallId: "eval-coalesced",
			session,
			cwd: session.cwd,
			sessionId: "speculative-eval-coalesced-test",
		});
		const args = { language: "js", reset: false, code: "abc" };
		const toolCall = { type: "toolCall" as const, id: "eval-coalesced", name: "eval", arguments: args };

		await shadow.update(toolCall, '{"language":"js","reset":false,"code":"a');
		expect(plannedCodes).toEqual(["a"]);
		await shadow.update(toolCall, '{"language":"js","reset":false,"code":"ab');
		await shadow.update(toolCall, '{"language":"js","reset":false,"code":"abc');
		await shadow.update(toolCall, JSON.stringify(args));
		firstPlan.resolve(null);
		await shadow.finalize({ args });

		expect(plannedCodes).toEqual(["a", "abc"]);
		await shadow.discard("test complete");
	});

	it("withholds shadow work until streamed reset is known", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-reset-gate-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-reset-gate-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-reset-gate", { language: "js", code: "globalThis.shadowWarm = true" });
		const admitted: string[] = [];
		const closeReasons: string[] = [];
		const coordinator: SpeculativeOperationSink = {
			maxInFlight: 2,
			async admit(definition) {
				admitted.push(definition.candidateId);
				return undefined;
			},
			close(reason) {
				closeReasons.push(reason);
			},
		};
		const code = 'tool.read({ path: "note.txt" })';
		const shadow = new EvalShadowCellSession({
			coordinator,
			parentToolCallId: "eval-reset-gate",
			session,
			cwd: directory,
			sessionId: "speculative-eval-reset-gate-test",
		});
		const streamingCall = { type: "toolCall" as const, id: "eval-reset-gate", name: "eval", arguments: {} };
		// Code streamed before reset: language known, reset unknown, object incomplete.
		const prefix = JSON.stringify({ language: "js", code }).slice(0, -1);

		await shadow.update(streamingCall, prefix);
		await shadow.finalize({ args: { language: "js", code } });

		expect(admitted).toEqual([]);

		const resetArgs = { language: "js", code, reset: true };
		await shadow.update(
			{ type: "toolCall" as const, id: "eval-reset-gate", name: "eval", arguments: resetArgs },
			JSON.stringify(resetArgs),
		);

		expect(admitted).toEqual([]);
		expect(closeReasons).toEqual(["reset eval cells cannot use retained shadow state"]);

		const admittedAfterKnownReset: string[] = [];
		const fresh = new EvalShadowCellSession({
			coordinator: {
				maxInFlight: 2,
				async admit(definition) {
					admittedAfterKnownReset.push(definition.candidateId);
					return undefined;
				},
				close() {},
			},
			parentToolCallId: "eval-reset-gate-kept",
			session,
			cwd: directory,
			sessionId: "speculative-eval-reset-gate-test",
		});
		const keptArgs = { language: "js", code, reset: false };
		const keptCall = { type: "toolCall" as const, id: "eval-reset-gate-kept", name: "eval", arguments: keptArgs };

		await fresh.update(keptCall, JSON.stringify(keptArgs));
		await fresh.finalize({ args: keptArgs });

		expect(admittedAfterKnownReset).toHaveLength(1);
		await fresh.discard("test complete");
	});

	it("falls back when a speculative child returns or throws an error", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-failure-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "images.autoResize": false });
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getEvalSessionId: () => "speculative-eval-failure-test",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			getEvalBridgeToolNames: () => ["read"],
			settings,
		};
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		await evalTool.execute("warm-failure", { language: "js", code: "globalThis.shadowWarm = true" });

		for (const failure of ["error-result", "rejection"] as const) {
			const outcome = Promise.withResolvers<SpeculativePhysicalOutcome>();
			const admitted = Promise.withResolvers<void>();
			const discardReasons: string[] = [];
			const shadow = new EvalShadowCellSession({
				coordinator: {
					maxInFlight: 2,
					async admit(definition) {
						admitted.resolve();
						return {
							candidateId: definition.candidateId,
							fingerprint: "test",
							effect: { kind: "pure" },
							outcome: outcome.promise,
							async commit() {
								throw new Error("failed speculative children must never commit");
							},
							async discard(reason) {
								discardReasons.push(reason);
							},
						};
					},
					close() {},
				},
				parentToolCallId: `eval-failure-${failure}`,
				session,
				cwd: directory,
				sessionId: "speculative-eval-failure-test",
			});
			const args = { language: "js", code: 'tool.read({ path: "note.txt" })' };
			const toolCall = {
				type: "toolCall" as const,
				id: `eval-failure-${failure}`,
				name: "eval",
				arguments: args,
			};

			await shadow.update(toolCall, JSON.stringify(args));
			await admitted.promise;
			if (failure === "error-result") {
				outcome.resolve({
					kind: "result",
					result: { content: [{ type: "text", text: "temporary failure" }], isError: true },
					isError: true,
				});
			} else {
				outcome.reject(new Error("temporary failure"));
			}
			await shadow.finalize({ args });

			await expect(
				shadow.claim("read", { path: "note.txt" }, { siteId: "js:0", occurrence: 0 }, Number.MAX_SAFE_INTEGER),
			).resolves.toBeUndefined();
			expect(discardReasons).toEqual([
				failure === "error-result" ? "speculative child returned an error" : "speculative child execution failed",
			]);
			await shadow.discard("test complete");
		}
	});
});

pythonIt("claims a Python read started before the outer eval call finishes streaming", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-python-"));
	temporaryDirectories.push(directory);
	await Bun.write(path.join(directory, "note.txt"), "before");
	const settings = Settings.isolated({
		"eval.autoBackground.enabled": false,
		"images.autoResize": false,
		"tools.speculativeExecution.enabled": true,
	});
	const session: ToolSession = {
		cwd: directory,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getEvalSessionId: () => "speculative-eval-python-test",
		getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
		getEvalBridgeToolNames: () => ["read"],
		settings,
	};
	const read = new ReadTool(session);
	const evalTool = new EvalTool(session);
	const warm = await evalTool.execute("warm-python", { language: "py", code: "shadow_warm = True" });
	expect(warm.isError).not.toBe(true);

	const finalized = read.speculation.finalized;
	if (!finalized) throw new Error("read tool has no finalized speculation policy");
	const executeRead = finalized.execute;
	const started = Promise.withResolvers<void>();
	let providerDone = false;
	let startedBeforeProviderDone = false;
	let executions = 0;
	finalized.execute = async (context, signal) => {
		executions += 1;
		startedBeforeProviderDone = !providerDone;
		started.resolve();
		return await executeRead(context, signal);
	};

	const host = new CodingAgentSpeculativeExecutionHost(settings, session, { hasHandlers: () => false });
	const mock = createMockModel({ responses: [] });
	const args = { language: "py", code: 'tool.read({"path": "note.txt"})' };
	let turn = 0;
	const streamFn = (_model: unknown, _context: Context) => {
		const response = new AssistantMessageEventStream();
		void (async () => {
			if (turn++ === 0) {
				const streamingCall = { type: "toolCall" as const, id: "eval-python", name: "eval", arguments: {} };
				setStreamingPartialJson(streamingCall, JSON.stringify(args));
				const streamingPartial = assistant([streamingCall], "toolUse");
				const toolCall = { ...streamingCall, arguments: args };
				const finalPartial = assistant([toolCall], "toolUse");
				response.push({ type: "start", partial: streamingPartial });
				response.push({ type: "toolcall_start", contentIndex: 0, partial: streamingPartial });
				response.push({
					type: "toolcall_delta",
					contentIndex: 0,
					delta: JSON.stringify(args),
					partial: streamingPartial,
				});
				await started.promise;
				response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: finalPartial });
				providerDone = true;
				response.push({ type: "done", reason: "toolUse", message: finalPartial });
				return;
			}
			const partial = assistant([{ type: "text", text: "done" }], "stop");
			response.push({ type: "start", partial });
			response.push({ type: "done", reason: "stop", message: partial });
		})();
		return response;
	};

	await agentLoop(
		[{ role: "user", content: "Read the note", timestamp: Date.now() }],
		{ systemPrompt: [""], messages: [], tools: [evalTool] },
		{
			model: mock.model,
			convertToLlm: identityConverter,
			speculativeToolExecution: { enabled: true, host },
		},
		undefined,
		streamFn,
	).result();

	expect(startedBeforeProviderDone).toBe(true);
	expect(executions).toBe(1);
});
