import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentMessage,
	type AgentTool,
	agentLoop,
	type SpeculativeOperationSink,
	type SpeculativePhysicalOutcome,
} from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
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
import type { ModelRegistry } from "../src/config/model-registry";

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
			"inspect_image.enabled": false,
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
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"images.autoResize": false,
			"inspect_image.enabled": false,
		});
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

	it("namespaces child tool-call IDs across outer eval calls", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-child-ids-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"images.autoResize": false,
			"inspect_image.enabled": false,
		});
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
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"images.autoResize": false,
			"inspect_image.enabled": false,
		});
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
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"images.autoResize": false,
			"inspect_image.enabled": false,
		});
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
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"images.autoResize": false,
			"inspect_image.enabled": false,
		});
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
		const args = { language: "js", code: "abc" };
		const toolCall = { type: "toolCall" as const, id: "eval-coalesced", name: "eval", arguments: args };

		await shadow.update(toolCall, '{"language":"js","code":"a');
		expect(plannedCodes).toEqual(["a"]);
		await shadow.update(toolCall, '{"language":"js","code":"ab');
		await shadow.update(toolCall, '{"language":"js","code":"abc');
		await shadow.update(toolCall, JSON.stringify(args));
		firstPlan.resolve(null);
		await shadow.finalize({ args });

		expect(plannedCodes).toEqual(["a", "abc"]);
		await shadow.discard("test complete");
	});

	it("discards admitted shadow work when a streamed cell later sets reset", async () => {
		const projected: jsContextManager.JavaScriptShadowPlanningResult = {
			snapshot: { revision: 1, values: {} },
			digest: "snapshot",
			plan: {
				operations: [
					{
						kind: "tool",
						call: {
							id: "js:0::0",
							siteId: "js:0",
							dynamicPath: [],
							occurrence: 0,
							name: "read",
							args: {
								kind: "object",
								entries: [{ key: "path", value: { kind: "literal", value: "note.txt" } }],
							},
							dependencies: [],
							controlDependencies: [],
							sourceOrder: 0,
							span: { start: 0, end: 32 },
						},
					},
				],
			},
		};
		const plan = vi.spyOn(jsContextManager, "shadowPlanIfPresent").mockResolvedValue(projected);
		const settings = Settings.isolated({});
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getToolForEvalBridge: name => (name === "read" ? eraseToolSchema(read) : undefined),
			settings,
		};
		const read = new ReadTool(session);
		const admitted = Promise.withResolvers<void>();
		const closeReasons: string[] = [];
		const shadow = new EvalShadowCellSession({
			coordinator: {
				maxInFlight: 2,
				async admit() {
					admitted.resolve();
					return undefined;
				},
				close(reason) {
					closeReasons.push(reason);
				},
			},
			parentToolCallId: "eval-reset",
			session,
			cwd: session.cwd,
			sessionId: "speculative-eval-reset-test",
		});
		const code = 'tool.read({ path: "note.txt" })';
		const args = { language: "js", code, reset: true };
		const prefix = JSON.stringify({ language: "js", code }).slice(0, -1);
		const toolCall = { type: "toolCall" as const, id: "eval-reset", name: "eval", arguments: args };

		await shadow.update(toolCall, prefix);
		await admitted.promise;
		await shadow.update(toolCall, JSON.stringify(args));

		expect(plan).toHaveBeenCalledTimes(1);
		expect(closeReasons).toEqual(["reset eval cells cannot use retained shadow state"]);
	});

	it("falls back when a speculative child returns or throws an error", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-failure-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"images.autoResize": false,
			"inspect_image.enabled": false,
		});
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
		"inspect_image.enabled": false,
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

it("gates a JavaScript completion until final-call reconciliation and claims its one provider result", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-completion-"));
	temporaryDirectories.push(directory);
	const settings = Settings.isolated({
		"eval.autoBackground.enabled": false,
		"images.autoResize": false,
		"inspect_image.enabled": false,
		"tools.approvalMode": "yolo",
		"tools.speculativeExecution.enabled": true,
		"tools.speculativeExecution.allowedRiskyOperations": ["eval.completion"],
	});
	const model = {
		id: "nested",
		name: "nested",
		api: "openai-responses",
		provider: "example",
		baseUrl: "https://api.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	} as Model<Api>;
	const modelRegistry = {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
	const session: ToolSession = {
		cwd: directory,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getEvalSessionId: () => "speculative-completion-test",
		getActiveModelString: () => "example/nested",
		getSessionId: () => "speculative-completion-test",
		getEvalBridgeToolNames: () => [],
		modelRegistry,
		settings,
	};
	const evalTool = new EvalTool(session);
	const warm = await evalTool.execute("warm-completion", {
		language: "js",
		code: "globalThis.completionShadowWarm = true",
	});
	expect(warm.isError).not.toBe(true);

	const completionStarted = Promise.withResolvers<void>();
	let completionCalls = 0;
	vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
		completionCalls += 1;
		completionStarted.resolve();
		return {
			role: "assistant",
			api: "openai-responses",
			provider: "example",
			model: "nested",
			stopReason: "stop",
			content: [{ type: "text", text: "nested result" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	});

	const host = new CodingAgentSpeculativeExecutionHost(settings, session, { hasHandlers: () => false });
	const mock = createMockModel({ responses: [] });
	const args = { language: "js", code: 'await completion("hello")' };
	let turn = 0;
	const streamFn = (_model: unknown, _context: Context) => {
		const response = new AssistantMessageEventStream();
		void (async () => {
			if (turn++ === 0) {
				const streamingCall = { type: "toolCall" as const, id: "eval-completion", name: "eval", arguments: {} };
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
				await Bun.sleep(20);
				expect(completionCalls).toBe(0);
				response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: finalPartial });
				await Bun.sleep(20);
				expect(completionCalls).toBe(0);
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
		[{ role: "user", content: "Complete once", timestamp: Date.now() }],
		{ systemPrompt: [""], messages: [], tools: [evalTool] },
		{
			model: mock.model,
			convertToLlm: identityConverter,
			speculativeToolExecution: { enabled: true, host },
		},
		undefined,
		streamFn,
	).result();

	expect(completionCalls).toBe(1);
});
