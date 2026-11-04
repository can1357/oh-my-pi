import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
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
import { collectPendingToolCalls } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
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
 * The provider stream of a turn the provider refuses: committed text (unless
 * `withText` is false), then the given tool calls in order. A `completed` call
 * closes (`toolcall_end`) before the next one starts; a call that is not
 * completed is cut off by the refusal while its arguments are still streaming
 * (where a call carrying large pasted content is most likely to be cut), so it
 * must be the last one. Without text a refused turn is replay-safe, which lets
 * the configured fallback chain try the next model.
 */
function refusedToolCallStream(
	model: Model<Api>,
	calls: Array<{ call: ToolCall; completed: boolean }>,
	withText = true,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = baseMessage(model);
		stream.push({ type: "start", partial });
		if (withText) {
			const text = "Dispatching the brief now.";
			partial.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 0, partial });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		}
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

const REPORT_TYPE = "refusal-tool-call-report";

/** Whether each refusal report in the context is final, in order. */
function reportFinals(messages: readonly AgentMessage[]): unknown[] {
	return messages.flatMap(m => {
		if (m.role !== "custom" || m.customType !== REPORT_TYPE) return [];
		const details = m.details;
		return [typeof details === "object" && details !== null && "final" in details ? details.final : undefined];
	});
}

function hasReport(messages: readonly AgentMessage[]): boolean {
	return messages.some(m => m.role === "custom" && m.customType === REPORT_TYPE);
}

function retriableErrorStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() =>
		stream.push({
			type: "error",
			reason: "error",
			error: {
				...baseMessage(model),
				stopReason: "error",
				errorStatus: 503,
				errorMessage: "503 Service unavailable",
			},
		}),
	);
	return stream;
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
		extensionRunner?: ExtensionRunner,
		extra: {
			settings?: Record<string, unknown>;
			sideStreamFn?: (model: Model<Api>) => AssistantMessageEventStream;
		} = {},
	) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		// Each request's messages as JSON: everything the model could read in it.
		const requests: string[] = [];
		// The model each request went to.
		const models: string[] = [];
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			// The session's own converter: it decides what of the context the model reads.
			convertToLlm,
			streamFn: (streamModel, context, options) => {
				requests.push(JSON.stringify(context.messages));
				models.push(`${streamModel.provider}/${streamModel.id}`);
				const next = responses[requests.length - 1] ?? (m => textStream(m, "unexpected extra turn"));
				return next(streamModel, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			...extra.settings,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			sideStreamFn: extra.sideStreamFn,
		});
		return { session, agent, requests, models };
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

	it("a finished refusal chain leaves no tool call pending in the session record", async () => {
		const dir = path.join(tempDir.path(), `pending-${Date.now()}`);
		const sessionManager = SessionManager.create(dir, dir);
		const { session } = createSession(
			[m => refusedToolCallStream(m, [{ call: writeCall, completed: true }]), m => refusedToolCallStream(m, [])],
			[recordingTool("write", [])],
			sessionManager,
		);

		await session.prompt("Write to the device");
		await session.waitForIdle();
		await sessionManager.flush();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a session file path");
		await session.dispose();
		await sessionManager.close();

		// A pending call here makes the next resume report a crashed process and
		// append an aborted turn, though nothing was running.
		const reloaded = await SessionManager.open(file);
		const pending = collectPendingToolCalls(reloaded.getBranch());
		await reloaded.close();
		expect(pending).toEqual([]);
	});

	it("a committed compaction between the report and the wake resumes the wake, and keeps the one-wake bound", async () => {
		const dir = path.join(tempDir.path(), `compact-${Date.now()}`);
		const sessionManager = SessionManager.create(dir, dir);
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event => ({
					compaction: {
						summary: "Earlier work was summarized.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
			dir,
			new EventBus(),
			runtime,
			"refusal-compaction-test",
		);
		const runner = new ExtensionRunner([extension], runtime, dir, sessionManager, modelRegistry);
		const { session, agent, requests } = createSession(
			[
				m => textStream(m, "Done with the first task."),
				m => refusedToolCallStream(m, [{ call: writeCall, completed: false }]),
				// The resumed wake is refused again, with no call: final report, no further wake.
				m => refusedToolCallStream(m, []),
				m => textStream(m, "unexpected extra wake"),
			],
			[recordingTool("write", [])],
			sessionManager,
			runner,
		);
		let compaction: Promise<unknown> | undefined;
		session.subscribeRunState(state => {
			if (state !== "idle" || compaction) return;
			if (!agent.state.messages.some(m => m.role === "custom" && m.customType === "refusal-tool-call-report"))
				return;
			compaction = session.compact(undefined, { mode: "soft" });
		});

		await session.prompt(`First task. ${"old work ".repeat(10000)}`);
		await session.waitForIdle();
		await session.prompt("Write to the device");
		await compaction;
		await session.waitForIdle();

		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(requests).toHaveLength(3);
		expect(requests[2]).toContain(REFUSAL);
		const reports = sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "refusal-tool-call-report");
		expect(reports).toHaveLength(2);
	});

	it("a user prompt queued during a finished chain gets its own wake when it is refused", async () => {
		const refused = (id: string) => (m: Model<Api>) =>
			refusedToolCallStream(m, [{ call: { ...writeCall, id }, completed: true }]);
		const { session, agent, requests } = createSession(
			[refused("toolu_a"), refused("toolu_b"), refused("toolu_c"), m => textStream(m, "Answering the new request.")],
			[recordingTool("write", [])],
		);
		let queued: Promise<unknown> | undefined;
		session.subscribeRunState(state => {
			if (state !== "idle" || queued) return;
			if (!agent.state.messages.some(m => m.role === "custom" && m.customType === "refusal-tool-call-report"))
				return;
			queued = session.prompt("A DIFFERENT REQUEST", { streamingBehavior: "steer" });
		});

		await session.prompt("Write to the device");
		await queued;
		await session.waitForIdle();

		// The new request's first refusal (request 3) is a first refusal: it wakes (request 4).
		const newRequestAt = requests.findIndex(r => r.includes("A DIFFERENT REQUEST"));
		expect(newRequestAt).toBeGreaterThanOrEqual(0);
		expect(requests.length).toBe(newRequestAt + 2);
		const reports = (requests.at(-1) ?? "").split("The provider ended your last response with a refusal");
		expect(reports.at(-1)).not.toContain("the session will NOT continue on its own this time");
	});

	// After a final report, a turn that something else starts. New work (a parent's
	// assignment; the user's own prompt is covered above) opens a new chain: refused,
	// it gets one wake. Anything that adds no new work does not: refused, it gets a
	// final report and no wake. That includes the operator's continue, which here
	// re-sends the refused request (the refused turns left the context, so the
	// user's prompt is the one still unanswered), and peer or extension messages, so
	// an extension that starts a turn every time the session goes idle cannot buy wakes.
	const starters: Array<{ kind: string; newWork: boolean; start: (session: AgentSession) => Promise<unknown> }> = [
		{
			kind: "a parent's follow-up assignment",
			newWork: true,
			start: session => session.prompt("A NEW ASSIGNMENT", { attribution: "agent" }),
		},
		{
			kind: "the operator's continue (it re-sends the refused request)",
			newWork: false,
			start: session => session.resume(),
		},
		{
			kind: "a peer agent's message",
			newWork: false,
			start: session =>
				session.deliverIrcMessage({ id: "peer-message", from: "peer", to: "me", body: "A note.", ts: Date.now() }),
		},
		{
			kind: "an extension notification",
			newWork: false,
			start: session =>
				session.sendCustomMessage(
					{ customType: "extension-notice", content: "A notice.", display: false, attribution: "agent" },
					{ triggerTurn: true },
				),
		},
		{
			kind: "an extension notification that accepts an empty stop",
			newWork: false,
			start: session =>
				session.sendCustomMessage(
					{ customType: "extension-notice", content: "A notice.", display: false, attribution: "agent" },
					{ triggerTurn: true, deliverAs: "nextTurn", acceptTerminalEmptyStop: true },
				),
		},
	];
	for (const { kind, newWork, start } of starters) {
		it(`${kind} after a final report ${newWork ? "gets one wake" : "gets no wake"} when refused`, async () => {
			const refused = (id: string) => (m: Model<Api>) =>
				refusedToolCallStream(m, [{ call: { ...writeCall, id }, completed: true }]);
			const { session, agent, requests } = createSession(
				[
					refused("toolu_a"),
					refused("toolu_b"),
					refused("toolu_c"),
					refused("toolu_d"),
					m => textStream(m, "unexpected extra wake"),
				],
				[recordingTool("write", [])],
			);
			await session.prompt("Write to the device");
			await session.waitForIdle();
			expect(requests).toHaveLength(2);

			await start(session);
			await session.waitForIdle();

			// New work: its turn (request 3) is refused and woken (request 4), whose refusal is final.
			// Otherwise its turn (request 3) is refused and its report is final.
			expect(requests).toHaveLength(newWork ? 4 : 3);
			expect(reportFinals(agent.state.messages)).toEqual(newWork ? [false, true, false, true] : [false, true, true]);
			expect(session.getLastAssistantMessage()?.errorMessage).toBe(REFUSAL);
		});
	}

	it("a compaction a hook vetoes between the report and the wake does not lose the wake", async () => {
		const dir = path.join(tempDir.path(), `veto-${Date.now()}`);
		const sessionManager = SessionManager.create(dir, dir);
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async () => ({ cancel: true }));
			},
			dir,
			new EventBus(),
			runtime,
			"refusal-veto-test",
		);
		const runner = new ExtensionRunner([extension], runtime, dir, sessionManager, modelRegistry);
		const { session, agent, requests } = createSession(
			[
				m => textStream(m, "Done with the first task."),
				m => refusedToolCallStream(m, [{ call: writeCall, completed: true }]),
				m => textStream(m, "I will split the write."),
			],
			[recordingTool("write", [])],
			sessionManager,
			runner,
		);
		let compaction: Promise<unknown> | undefined;
		session.subscribeRunState(state => {
			if (state !== "idle" || compaction) return;
			if (!agent.state.messages.some(m => m.role === "custom" && m.customType === "refusal-tool-call-report"))
				return;
			compaction = session.compact(undefined, { mode: "soft" }).catch(error => error);
		});

		await session.prompt(`First task. ${"old work ".repeat(10000)}`);
		await session.waitForIdle();
		await session.prompt("Write to the device");
		const vetoed = await compaction;
		await session.waitForIdle();

		expect(vetoed).toBeInstanceOf(Error);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
		expect(requests).toHaveLength(3);
		expect(requests[2]).toContain(REFUSAL);
	});

	/** An extension that answers every compaction with a summary, or vetoes it. */
	async function compactionRunner(dir: string, sessionManager: SessionManager, veto: boolean) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event =>
					veto
						? { cancel: true }
						: {
								compaction: {
									summary: "Earlier work was summarized.",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							},
				);
			},
			dir,
			new EventBus(),
			runtime,
			"refusal-compaction-runner",
		);
		return new ExtensionRunner([extension], runtime, dir, sessionManager, modelRegistry);
	}

	/** Calls `act` once, the first time the session goes idle holding a refusal report. */
	function onceIdleAfterReport(session: AgentSession, agent: Agent, act: () => void): void {
		let done = false;
		session.subscribeRunState(state => {
			if (state !== "idle" || done || !hasReport(agent.state.messages)) return;
			done = true;
			act();
		});
	}

	it("every way the woken turn can start reads the same answer: its refusal is final and nothing more runs", async () => {
		const executed: string[] = [];
		const tools = [recordingTool("write", executed)];
		const refused =
			(id: string, withText = true) =>
			(m: Model<Api>) =>
				refusedToolCallStream(m, [{ call: { ...writeCall, id }, completed: true }], withText);
		let extraTurns = 0;
		const extraTurn = (m: Model<Api>) => {
			extraTurns++;
			return textStream(m, "unexpected extra turn");
		};
		const fileSession = (name: string) => {
			const dir = path.join(tempDir.path(), `${name}-${Date.now()}`);
			return { dir, sessionManager: SessionManager.create(dir, dir) };
		};

		// Each driver starts the woken turn its own way and returns the context it ends with.
		const drivers: Record<string, () => Promise<readonly AgentMessage[]>> = {
			// The wake's request fails with a retriable error; the automatic retry is refused.
			retry: async () => {
				const { session, agent, requests } = createSession(
					[refused("a"), retriableErrorStream, refused("b"), extraTurn],
					tools,
				);
				await session.prompt("Write to the device");
				await session.waitForIdle();
				expect(requests).toHaveLength(3);
				return agent.state.messages;
			},
			// The wake is refused on the primary model; the fallback model is refused too.
			fallback: async () => {
				const { session, agent, models } = createSession(
					[refused("a"), refused("b", false), refused("c"), extraTurn],
					tools,
					undefined,
					undefined,
					{
						settings: {
							"retry.modelFallback": true,
							"retry.fallbackChains": { default: ["anthropic/claude-haiku-4-5"] },
						},
					},
				);
				await session.prompt("Write to the device");
				await session.waitForIdle();
				expect(models).toEqual([
					"anthropic/claude-sonnet-4-5",
					"anthropic/claude-sonnet-4-5",
					"anthropic/claude-haiku-4-5",
				]);
				return agent.state.messages;
			},
			// A committed compaction between the report and the wake resumes it.
			"compaction resume": async () => {
				const { dir, sessionManager } = fileSession("driver-compact");
				const runner = await compactionRunner(dir, sessionManager, false);
				const { session, agent } = createSession(
					[m => textStream(m, "Done with the first task."), refused("a"), refused("b"), extraTurn],
					tools,
					sessionManager,
					runner,
				);
				let compaction: Promise<unknown> | undefined;
				onceIdleAfterReport(session, agent, () => {
					compaction = session.compact(undefined, { mode: "soft" });
				});
				await session.prompt(`First task. ${"old work ".repeat(10000)}`);
				await session.waitForIdle();
				await session.prompt("Write to the device");
				await compaction;
				await session.waitForIdle();
				expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
				return agent.state.messages;
			},
			// The session switches to another session before the wake, runs a turn there, and comes back.
			"switch back": async () => {
				const { dir, sessionManager } = fileSession("driver-switch");
				const other = SessionManager.create(dir, dir);
				other.appendMessage({ role: "user", content: "OTHER SESSION", timestamp: Date.now() });
				await other.ensureOnDisk();
				const otherFile = other.getSessionFile();
				await other.close();
				const { session, agent } = createSession(
					[refused("a"), m => textStream(m, "Other session answered."), refused("b"), extraTurn],
					tools,
					sessionManager,
				);
				const original = sessionManager.getSessionFile();
				if (!otherFile || !original) throw new Error("Expected session files");
				let switching: Promise<unknown> | undefined;
				onceIdleAfterReport(session, agent, () => {
					switching = session.switchSession(otherFile, { keepModel: true });
				});
				await session.prompt("Write to the device");
				await switching;
				await session.waitForIdle();
				await session.prompt("OTHER REQUEST");
				await session.waitForIdle();
				await session.switchSession(original, { keepModel: true });
				await session.waitForIdle();
				return agent.state.messages;
			},
			// The process ends before the wake; `omp --restore` reopens the session.
			reopen: async () => {
				const { sessionManager } = fileSession("driver-reopen");
				const first = createSession([refused("a"), extraTurn], tools, sessionManager);
				let disposing: Promise<void> | undefined;
				onceIdleAfterReport(first.session, first.agent, () => {
					disposing = first.session.dispose();
				});
				await first.session.prompt("Write to the device");
				await disposing;
				await sessionManager.flush();
				const file = sessionManager.getSessionFile();
				await sessionManager.close();
				if (!file) throw new Error("Expected a session file");
				const reopened = await SessionManager.open(file);
				const { session, agent } = createSession([refused("b"), extraTurn], tools, reopened);
				agent.replaceMessages(reopened.buildSessionContext().messages);
				expect(await session.restoreInterruptedTurn()).toBe(true);
				await session.waitForIdle();
				return agent.state.messages;
			},
		};

		const outcomes: Record<string, unknown> = {};
		for (const [name, drive] of Object.entries(drivers)) {
			extraTurns = 0;
			const messages = await drive();
			outcomes[name] = { reportFinals: reportFinals(messages), extraTurns };
			await session?.dispose();
			session = undefined;
		}
		const answer = { reportFinals: [false, true], extraTurns: 0 };
		expect(outcomes).toEqual(Object.fromEntries(Object.keys(drivers).map(name => [name, answer])));
		expect(executed).toEqual([]);
	});

	describe("while a context-transfer summary is generated", () => {
		let releaseSummary = () => {};
		const summaryStream = (m: Model<Api>) => {
			const stream = new AssistantMessageEventStream();
			releaseSummary = () => {
				void (async () => {
					for await (const event of textStream(m, "Earlier completed work summarized.")) stream.push(event);
				})();
			};
			return stream;
		};

		it("a refusal still reports the dropped call, and the model reads it after the summary commits", async () => {
			let started: Promise<unknown> | undefined;
			const { session, requests } = createSession(
				[
					m => textStream(m, "Done with the first task."),
					m => {
						// The summary starts while this response streams; the refusal lands during it.
						started = session?.handoff();
						return refusedToolCallStream(m, [{ call: writeCall, completed: false }]);
					},
					m => textStream(m, "I read the report."),
				],
				[recordingTool("write", [])],
				undefined,
				undefined,
				{ sideStreamFn: summaryStream },
			);
			session.subscribeRunState(state => {
				if (state === "idle" && requests.length === 2) releaseSummary();
			});
			await session.prompt(`First task. ${"old work ".repeat(20000)}`);
			await session.waitForIdle();
			await session.prompt("Write to the device");
			await started;
			await session.waitForIdle();

			expect(requests).toHaveLength(3);
			expect(requests[2]).toContain(REFUSAL);
			expect(requests[2]).toContain("`write` (cut off while its arguments were still streaming)");
		});

		it("a context-transfer summary begun between the report and the wake keeps the wake and its final report", async () => {
			const { session, agent, requests } = createSession(
				[
					m => textStream(m, "Done with the first task."),
					m => refusedToolCallStream(m, [{ call: writeCall, completed: true }]),
					m => refusedToolCallStream(m, []),
					m => textStream(m, "unexpected extra turn"),
				],
				[recordingTool("write", [])],
				undefined,
				undefined,
				// The summary completes on its own: whether the woken turn is refused while
				// it is generated or after it commits, the answer must be the same.
				{ sideStreamFn: m => textStream(m, "Earlier completed work summarized.") },
			);
			let summary: Promise<unknown> | undefined;
			onceIdleAfterReport(session, agent, () => {
				summary = session.handoff();
			});
			await session.prompt(`First task. ${"old work ".repeat(20000)}`);
			await session.waitForIdle();
			await session.prompt("Write to the device");
			await summary;
			await session.waitForIdle();

			expect(requests).toHaveLength(3);
			expect(reportFinals(agent.state.messages)).toEqual([false, true]);
		});
	});

	for (const withdrawn of [true, false]) {
		it(`a reload ${withdrawn ? "keeps a wake the user withdrew withdrawn" : "restarts a wake nobody withdrew"}`, async () => {
			const dir = path.join(tempDir.path(), `withdraw-${withdrawn}-${Date.now()}`);
			const sessionManager = SessionManager.create(dir, dir);
			const { session, agent, requests } = createSession(
				[
					m => refusedToolCallStream(m, [{ call: writeCall, completed: true }]),
					m => textStream(m, "I read the report."),
				],
				[recordingTool("write", [])],
				sessionManager,
			);
			let reloaded: Promise<unknown> | undefined;
			onceIdleAfterReport(session, agent, () => {
				reloaded = (async () => {
					// The user's interrupt, before the wake runs.
					if (withdrawn) await session.abort();
					const file = sessionManager.getSessionFile();
					if (!file) throw new Error("Expected a session file");
					await session.switchSession(file, { keepModel: true });
				})();
			});
			await session.prompt("Write to the device");
			await reloaded;
			await session.waitForIdle();

			expect(requests).toHaveLength(withdrawn ? 1 : 2);
			// A fresh process agrees: `omp --restore` restarts only a wake nobody withdrew.
			await sessionManager.flush();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a session file");
			const reopened = await SessionManager.open(file);
			const persisted = reopened.getEntries().flatMap(e => (e.type === "custom_message" ? [e.customType] : []));
			expect(persisted).toEqual(withdrawn ? [REPORT_TYPE, "refusal-wake-withdrawn"] : [REPORT_TYPE]);
			await reopened.close();
		});
	}
});
