import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, ToolCall } from "@oh-my-pi/pi-ai";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const REFUSAL = "Refusal (reasoning_extraction): This request was declined.";

function baseMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * The provider stream of a turn the provider refuses: committed text, then the
 * given tool calls in order. A `completed` call closes (`toolcall_end`) before
 * the next one starts; a call that is not completed is cut off by the refusal
 * while its arguments are still streaming (where a call carrying large pasted
 * content is most likely to be cut), so it must be the last one.
 */
function refusedToolCallStream(
	model: Model<Api>,
	calls: Array<{ call: ToolCall; completed: boolean }>,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = baseMessage(model);
		const text = "Dispatching the brief now.";
		partial.content.push({ type: "text", text });
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		for (const { call, completed } of calls) {
			const contentIndex = partial.content.length;
			partial.content.push(call);
			stream.push({ type: "toolcall_start", contentIndex, partial });
			const args = JSON.stringify(call.arguments);
			stream.push({
				type: "toolcall_delta",
				contentIndex,
				delta: completed ? args : args.slice(0, Math.floor(args.length / 2)),
				partial,
			});
			if (completed) stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial });
		}
		stream.push({
			type: "error",
			reason: "error",
			error: {
				...partial,
				stopReason: "error",
				stopDetails: {
					type: "refusal",
					category: "reasoning_extraction",
					explanation: "This request was declined.",
				},
				errorMessage: REFUSAL,
			},
		});
	});
	return stream;
}

function textStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = baseMessage(model);
		partial.content.push({ type: "text", text });
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	});
	return stream;
}

function recordingTool(name: string, executed: string[]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ content: "string" }),
		async execute(toolCallId) {
			executed.push(toolCallId);
			return { content: [{ type: "text", text: "ran" }], details: {} };
		},
	} as AgentTool;
}

describe("AgentSession after a provider refusal ends a tool-call turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-refusal-tool-call-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	function createSession(
		responses: Array<(model: Model<Api>, options?: SimpleStreamOptions) => AssistantMessageEventStream>,
		tools: AgentTool[],
		sessionManager: SessionManager = SessionManager.inMemory(),
	) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		// Each request's messages as JSON: everything the model could read in it.
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			// The session's own converter: it decides what of the context the model reads.
			convertToLlm,
			streamFn: (streamModel, context, options) => {
				requests.push(JSON.stringify(context.messages));
				const next = responses[requests.length - 1] ?? (m => textStream(m, "unexpected extra turn"));
				return next(streamModel, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return { session, agent, requests };
	}

	const taskCall: ToolCall = {
		type: "toolCall",
		id: "toolu_refused_task",
		name: "task",
		arguments: { content: "A large pasted brief. ".repeat(50) },
	};
	const writeCall: ToolCall = {
		type: "toolCall",
		id: "toolu_refused_write",
		name: "write",
		arguments: { content: "A large device payload. ".repeat(50) },
	};
	const cases: Array<{ shape: string; calls: Array<{ call: ToolCall; completed: boolean }> }> = [
		{ shape: "cut a call off mid-arguments", calls: [{ call: taskCall, completed: false }] },
		{
			shape: "landed after a call closed, before the next one started",
			calls: [{ call: taskCall, completed: true }],
		},
		{
			shape: "landed after one call closed and cut off the next",
			calls: [
				{ call: taskCall, completed: true },
				{ call: writeCall, completed: false },
			],
		},
	];
	for (const { shape, calls } of cases) {
		it(`reports every refused call to the model and gives it a turn (refusal ${shape})`, async () => {
			const executed: string[] = [];
			const { session, requests } = createSession(
				[m => refusedToolCallStream(m, calls), m => textStream(m, "I will split the brief.")],
				[recordingTool("task", executed), recordingTool("write", executed)],
			);

			await session.prompt("Dispatch the brief");
			await session.waitForIdle();

			// No call of the refused turn ran ...
			expect(executed).toEqual([]);
			// ... the session asked the model again without another prompt ...
			expect(requests).toHaveLength(2);
			// ... and that request names each failed call and the provider's reason,
			const seen = requests[1] ?? "";
			for (const { call, completed } of calls) {
				expect(seen).toContain(
					completed
						? `\`${call.name}\`\\n`
						: `\`${call.name}\` (cut off while its arguments were still streaming)`,
				);
			}
			expect(seen).toContain(REFUSAL);
			// without replaying the refused turn (replaying it draws the refusal again).
			expect(seen).not.toContain("Dispatching the brief now.");
			expect(seen).not.toContain("A large pasted brief.");
			expect(session.getLastAssistantMessage()?.content).toEqual([
				{ type: "text", text: "I will split the brief." },
			]);
			// A reload sees what the model saw: the report, and no orphaned placeholder result.
			const persisted = session.sessionManager
				.getEntries()
				.map(entry =>
					entry.type === "message"
						? entry.message.role
						: entry.type === "custom_message"
							? entry.customType
							: entry.type,
				);
			expect(persisted).not.toContain("toolResult");
			expect(persisted).toContain("refusal-tool-call-report");
		});
	}

	it("stops after one wake when the woken turn is refused again, and says so", async () => {
		const executed: string[] = [];
		const { session, requests } = createSession(
			[
				m => refusedToolCallStream(m, [{ call: writeCall, completed: false }]),
				m => refusedToolCallStream(m, [{ call: { ...writeCall, id: "toolu_second" }, completed: true }]),
				m => textStream(m, "I will change the request."),
			],
			[recordingTool("write", executed)],
		);

		await session.prompt("Write to the device");
		await session.waitForIdle();

		expect(executed).toEqual([]);
		expect(requests).toHaveLength(2);
		const settled = session.getLastAssistantMessage();
		expect(settled?.stopReason).toBe("error");
		expect(settled?.errorMessage).toBe(REFUSAL);

		// The next turn, whoever starts it, reads both reports; the second says no retry is coming.
		await session.prompt("What happened?");
		await session.waitForIdle();
		const seen = requests[2] ?? "";
		expect(seen.split("The provider ended your last response with a refusal").length - 1).toBe(2);
		expect(seen).toContain("the session will NOT continue on its own this time");
	});

	it("a woken turn refused before any tool call still gets the final report", async () => {
		const { session, requests } = createSession(
			[m => refusedToolCallStream(m, [{ call: writeCall, completed: true }]), m => refusedToolCallStream(m, [])],
			[recordingTool("write", [])],
		);

		await session.prompt("Write to the device");
		await session.waitForIdle();
		expect(requests).toHaveLength(2);

		await session.prompt("What happened?");
		await session.waitForIdle();
		const seen = requests[2] ?? "";
		expect(seen.split("The provider ended your last response with a refusal").length - 1).toBe(2);
		expect(seen).toContain("That response made no tool call.");
		expect(seen).toContain("the session will NOT continue on its own this time");
	});

	it("a message delivered between a report and the next turn does not reset the one-wake bound", async () => {
		const refusals = Array.from(
			{ length: 4 },
			(_, n) => (m: Model<Api>) =>
				refusedToolCallStream(m, [{ call: { ...writeCall, id: `toolu_${n}` }, completed: true }]),
		);
		const { session, agent, requests } = createSession(refusals, [recordingTool("write", [])]);
		// An extension reminder lands right after the first report, before the woken turn.
		let steered = false;
		session.subscribeRunState(state => {
			if (state !== "idle" || steered) return;
			if (!agent.state.messages.some(m => m.role === "custom" && m.customType === "refusal-tool-call-report"))
				return;
			steered = true;
			agent.steer({
				role: "custom",
				customType: "extension-reminder",
				content: "A reminder from an extension.",
				display: false,
				timestamp: Date.now(),
			});
		});

		await session.prompt("Write to the device");
		await session.waitForIdle();

		expect(steered).toBe(true);
		// The woken turn (carrying the reminder) is refused again: final report, no second wake.
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("A reminder from an extension.");
	});

	it("two refused turns at the start of a new session survive a reload with the request and both reports", async () => {
		const dir = path.join(tempDir.path(), `reload-${Date.now()}`);
		const sessionManager = SessionManager.create(dir, dir);
		const { session } = createSession(
			[
				m => refusedToolCallStream(m, [{ call: writeCall, completed: true }]),
				m => refusedToolCallStream(m, [{ call: { ...writeCall, id: "toolu_second" }, completed: false }]),
			],
			[recordingTool("write", [])],
			sessionManager,
		);

		await session.prompt("THE ORIGINAL REQUEST");
		await session.waitForIdle();
		await sessionManager.flush();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a session file path");
		await session.dispose();
		await sessionManager.close();

		const reloaded = await SessionManager.open(file);
		const replay = reloaded.buildSessionContext().messages;
		await reloaded.close();
		expect(JSON.stringify(replay)).toContain("THE ORIGINAL REQUEST");
		expect(replay.filter(m => m.role === "custom" && m.customType === "refusal-tool-call-report")).toHaveLength(2);
		expect(replay.some(m => m.role === "toolResult")).toBe(false);
	});

	it("keeps a turn whose call the provider ran itself, in context and in the session record", async () => {
		const dir = path.join(tempDir.path(), `server-${Date.now()}`);
		const sessionManager = SessionManager.create(dir, dir);
		const serverCall = { ...writeCall, id: "toolu_server_ran", [kCursorExecResolved]: true as const };
		const { session, agent } = createSession(
			[
				(m, options) => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(async () => {
						const partial = baseMessage(m);
						partial.content = [serverCall];
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: serverCall, partial });
						await options?.cursorOnToolResult?.({
							role: "toolResult",
							toolCallId: serverCall.id,
							toolName: serverCall.name,
							content: [{ type: "text", text: "written by the provider" }],
							isError: false,
							timestamp: Date.now(),
						});
						stream.push({
							type: "error",
							reason: "error",
							error: {
								...partial,
								stopReason: "error",
								stopDetails: { type: "refusal", category: "reasoning_extraction" },
								errorMessage: REFUSAL,
							},
						});
					});
					return stream;
				},
			],
			[recordingTool("write", [])],
			sessionManager,
		);

		await session.prompt("Write to the device");
		await session.waitForIdle();
		const hasCallAndResult = (messages: readonly { role: string }[]) => {
			const json = JSON.stringify(messages);
			return json.includes('"id":"toolu_server_ran"') && json.includes("written by the provider");
		};
		expect(hasCallAndResult(agent.state.messages)).toBe(true);

		await sessionManager.flush();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a session file path");
		await session.dispose();
		await sessionManager.close();
		const reloaded = await SessionManager.open(file);
		// The record keeps the call and, after it, its real result (the transcript
		// view). Replay into a request drops every error turn with its results, as
		// it does at main for any failed turn, so no result is left without its call.
		const record = reloaded.buildSessionContext({ transcript: true }).messages;
		const replay = reloaded.buildSessionContext().messages;
		await reloaded.close();
		const callIndex = record.findIndex(m => m.role === "assistant" && JSON.stringify(m).includes("toolu_server_ran"));
		const resultIndex = record.findIndex(m => m.role === "toolResult" && m.toolCallId === "toolu_server_ran");
		expect(callIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBeGreaterThan(callIndex);
		expect(replay.some(m => m.role === "toolResult")).toBe(false);
	});

	it("an abort after the report and before the wake cancels the wake", async () => {
		const { session, agent, requests } = createSession(
			[m => refusedToolCallStream(m, [{ call: writeCall, completed: true }]), m => textStream(m, "unexpected wake")],
			[recordingTool("write", [])],
		);
		let aborted = false;
		session.subscribeRunState(state => {
			if (state !== "idle" || aborted) return;
			if (!agent.state.messages.some(m => m.role === "custom" && m.customType === "refusal-tool-call-report"))
				return;
			aborted = true;
			void session.abort();
		});

		await session.prompt("Write to the device");
		await session.waitForIdle();

		expect(aborted).toBe(true);
		expect(requests).toHaveLength(1);
		// The report stays for whatever turn comes next.
		expect(agent.state.messages.some(m => m.role === "custom" && m.customType === "refusal-tool-call-report")).toBe(
			true,
		);
	});
});
