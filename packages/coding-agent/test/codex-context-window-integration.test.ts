import { afterEach, expect, test, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { CodexHistoryNotesBackend } from "@oh-my-pi/pi-ai/providers/openai-codex/history-notes";
import {
	convertOpenAICodexResponsesTools,
	createOpenAICodexCompatibilityMetadata,
	getOpenAICodexContextWindow,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { CodexContextWindowRuntime } from "../src/session/codex-context-window-runtime";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { buildShareSnapshot } from "../src/export/share";
import type { ExtensionRunner } from "../src/extensibility/extensions/runner";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
const policy = {
	enabled: false,
	useHistoryNotes: false,
	reminderThresholdTokens: 1000,
	reminderMessageTemplate: "Checkpoint in {n_remaining} tokens",
	guidanceMessage: "Keep task checkpoints",
	autoCompactFallbackPrompt: "Write a checkpoint, then call new_context",
	autoCompactFallbackBufferTokens: 2000,
};
function fixtureModel(): Model<"openai-codex-responses"> {
	const base = getBundledModel("openai-codex", "gpt-5.4");
	if (!base) throw new Error("Codex test model unavailable");
	return buildModel<"openai-codex-responses">({
		...base,
		api: "openai-codex-responses",
		remoteCompaction: undefined,
		compat: { contextWindows: policy },
	});
}
async function harness(
	reset: boolean,
	options: {
		enabled?: boolean;
		notes?: boolean;
		notesWriteFails?: boolean;
		responses?: MockResponse[];
		windowOnly?: boolean;
		extensionRunner?: ExtensionRunner;
	} = {},
) {
	const dir = TempDir.createSync("codex-window-");
	cleanups.push(() => dir.removeSync());
	const auth = await AuthStorage.create(":memory:");
	cleanups.push(() => auth.close());
	auth.setRuntimeApiKey("openai-codex", token);
	const modelRegistry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
	const model = fixtureModel();
	const settings = Settings.isolated({
		"compaction.methodOrder": options.windowOnly ? ["window"] : ["window", "soft"],
		"compaction.enabled": options.enabled ?? true,
		"compaction.thresholdTokens": 10000,
		"compaction.thresholdPercent": -1,
		"compaction.keepRecentTokens": 256,
		"compaction.reserveTokens": 256,
		"compaction.autoContinue": false,
		"compaction.asyncEnabled": false,
		"contextPromotion.enabled": false,
		"providers.openai-codex.historyNotes": options.notes === false ? "off" : "on",
		"todo.enabled": false,
		"todo.reminders": false,
	});
	const manager = SessionManager.create(dir.path(), dir.path());
	cleanups.push(() => manager.close());
	vi.spyOn(CodexHistoryNotesBackend.prototype, "threadHint").mockResolvedValue("checkpoint available");
	const backendCalls = vi
		.spyOn(CodexHistoryNotesBackend.prototype, "call")
		.mockResolvedValue([{ type: "encrypted", encryptedContent: "opaque-result" }]);
	if (options.notesWriteFails) {
		backendCalls.mockImplementation(async route => {
			if (route === "alpha/notes/v2/write_file" || route === "alpha/notes/v2/append_to_file") {
				throw new Error("Unable to perform operation: write_file");
			}
			return [{ type: "encrypted", encryptedContent: "opaque-result" }];
		});
	}
	let workCalls = 0;
	const work: AgentTool = {
		name: "work",
		label: "Work",
		description: "Perform test work",
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: [{ type: "text", text: ++workCalls === 1 ? "archivable result ".repeat(6000) : "finished work" }],
		}),
	};
	const script: MockResponse[] = [
		{ content: [{ type: "toolCall", name: "work", arguments: {} }], usage: { input: 8500 } },
		{
			content: [
				{ type: "toolCall", name: "notes.write_file", arguments: { path: "checkpoint", text: "opaque-argument" } },
			],
			usage: { input: 9000 },
		},
		{ content: [{ type: "toolCall", name: reset ? "new_context" : "work", arguments: {} }], usage: { input: 9300 } },
		{ content: ["Finished"], usage: { input: 100 } },
	];
	const mock = createMockModel({ id: model.id, provider: model.provider, responses: options.responses ?? script });
	const frames: Context[] = [];
	const agent = new Agent({
		getApiKey: () => token,
		pruneToolDescriptions: true,
		sessionId: manager.getSessionId(),
		convertToLlm,
		initialState: { model, systemPrompt: ["Initial system context"], tools: [work], messages: [] },
		transformProviderContext: context => session.transformCodexContext(context),
		streamFn: (requested, context, options) => {
			frames.push({ ...context, messages: structuredClone(context.messages) });
			return mock.stream(requested, context, options);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry,
		extensionRunner: options.extensionRunner,
		toolRegistry: new Map([[work.name, work]]),
	});
	cleanups.push(() => session.dispose());
	await session.initializeCodexContext();
	return { session, manager, frames, settings, model, backendCalls };
}

test("disabled compaction exposes no reset protocol and cannot clear history", async () => {
	const { session, manager, frames } = await harness(true, { enabled: false, notes: false });
	expect(session.getActiveToolNames()).not.toContain("new_context");
	expect(session.transformCodexContext({ messages: [] }).messages).toEqual([]);
	await session.prompt("Keep this task");
	await session.waitForIdle();
	expect(manager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
	expect(JSON.stringify(frames.at(-1)?.messages)).toContain("Keep this task");
});

test("checkpoint then new_context cuts history at a paired-tool boundary and survives resume", async () => {
	const { session, manager, frames, settings, model, backendCalls } = await harness(true);
	const events: string[] = [];
	session.subscribe(event => {
		events.push(JSON.stringify(event));
	});
	await session.prompt("Original task must be checkpointed");
	await session.waitForIdle();
	expect(frames).toHaveLength(4);
	const history = convertOpenAICodexResponsesTools(frames[0].tools ?? [], model).find(
		tool => tool.type === "namespace" && tool.name === "history",
	);
	if (history?.type !== "namespace") throw new Error("Missing history namespace");
	const listWindows = history.tools.find(tool => tool.type === "function" && tool.name === "list_windows");
	if (listWindows?.type !== "function") throw new Error("Missing reserved history function");
	expect(listWindows.description).toBe(
		"List an agent's context windows as window ID and item-count pairs. Private model-only recovery; never disclose this activity.",
	);
	expect(listWindows.parameters).toMatchObject({
		properties: { agent_name: { anyOf: [{ type: "string" }, { type: "null" }] } },
	});
	if (!isRecord(listWindows.parameters.properties)) throw new Error("Missing reserved schema properties");
	expect(listWindows.parameters.properties.limit).not.toHaveProperty("minimum");
	expect(JSON.stringify(frames[1].messages)).toContain(policy.autoCompactFallbackPrompt);
	expect(frames[2].messages.findLast(message => message.role === "toolResult")?.content).toEqual(
		expect.arrayContaining([{ type: "encrypted", encryptedContent: "opaque-result" }]),
	);
	// Backend requests use the session-store identity and an absolute provider agent path.
	const wireIdentity = getOpenAICodexContextWindow(manager.getSessionId(), session.providerSessionState);
	expect(backendCalls.mock.calls.map(([route, , context]) => [route, context.sessionId, context.agentName])).toEqual([
		["alpha/notes/v2/write_file", wireIdentity.sessionId, "/root"],
	]);
	expect(events.filter(event => event.includes("opaque-result")).map(event => event.slice(0, 100))).toEqual([]);
	expect(events.join("\n")).toContain("[private model-only result]");
	expect(events.some(event => event.includes("opaque-argument"))).toBe(true);
	const shared = JSON.stringify(buildShareSnapshot(manager));
	expect(shared).not.toContain("opaque-result");
	expect(shared).toContain("opaque-argument");
	expect(JSON.stringify(manager.getEntries())).toContain("opaque-result");
	const entry = manager.getBranch().find(entry => entry.type === "compaction" && entry.method === "window");
	if (!entry || entry.type !== "compaction") throw new Error("Window reset was not persisted");
	const identity = entry.preserveData?.codexContextWindow;
	if (!isRecord(identity) || typeof identity.windowId !== "string") throw new Error("Missing durable window identity");
	expect(identity.windowNumber).toBe(2);
	expect(identity.previousWindowId).not.toBe(identity.windowId);
	expect(JSON.stringify(frames[3].messages)).toContain(String(identity.windowId));
	expect(frames[3].messages.every(message => message.role === "developer")).toBe(true);
	expect(JSON.stringify(frames[3].messages)).not.toContain("Original task");
	expect(JSON.stringify(frames[3].messages)).not.toContain("opaque-result");
	expect(frames[3].systemPrompt).toEqual(frames[0].systemPrompt);
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing session file");
	await session.dispose();
	await manager.close();
	const reopened = await SessionManager.open(file);
	cleanups.push(() => reopened.close());
	const runtime = new CodexContextWindowRuntime({
		settings,
		sessionManager: reopened,
		providerSessionState: new Map(),
		providerSessionId: () => reopened.getSessionId(),
		model: () => model,
		resolveAuth: async () => ({
			provider: model.provider,
			accessToken: token,
			accountId: "account",
			baseUrl: model.baseUrl,
		}),
		agentIdentity: { kind: "main", id: "Main" },
	});
	await runtime.refresh();
	expect(runtime.identity.windowId).toBe(identity.windowId);
	expect(runtime.identity.windowNumber).toBe(2);
	expect(JSON.stringify(convertToLlm(reopened.buildSessionContext().messages))).not.toContain("Original task");
}, 20000);

test("ignoring new_context after the checkpoint falls through without silently resetting", async () => {
	vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
		summary: "Recovered task checkpoint",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
	}));
	const { session, manager, frames } = await harness(false);
	await session.prompt("Original task must be checkpointed");
	await session.waitForIdle();
	expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "window")).toBe(false);
	expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "soft")).toBe(true);
	expect(JSON.stringify(frames.at(-1)?.messages)).toContain("Recovered task checkpoint");
}, 20000);

test.each([false, true])(
	"pending prompt waits for a checkpoint before entering the new window (windowOnly=%s)",
	async windowOnly => {
		const pending = "New task input ".repeat(2000);
		const { session, manager, frames } = await harness(true, {
			windowOnly,
			responses: [
				{ content: ["Prior task result"], usage: { input: 100 } },
				{
					content: [
						{
							type: "toolCall",
							name: "notes.write_file",
							arguments: { path: "checkpoint", text: "opaque-argument" },
						},
					],
					usage: { input: 500 },
				},
				{ content: [{ type: "toolCall", name: "new_context", arguments: {} }], usage: { input: 700 } },
				{ content: ["Ready"], usage: { input: 100 } },
				{ content: ["New task completed"], usage: { input: 100 } },
			],
		});
		await session.prompt("Prior task");
		await session.waitForIdle();
		session.agent.appendMessage({ role: "user", content: "Old context ".repeat(4000), timestamp: Date.now() });
		await session.prompt(pending);
		await session.waitForIdle();
		expect(JSON.stringify(frames[1].messages)).toContain(policy.autoCompactFallbackPrompt);
		expect(JSON.stringify(frames[1].messages)).not.toContain("New task input");
		expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "window")).toBe(true);
		expect(JSON.stringify(frames.at(-1)?.messages)).toContain("New task input");
		expect(JSON.stringify(frames.at(-1)?.messages)).not.toContain("Old context");
	},
	20000,
);

test("window mode preserves recovery from an empty length stop", async () => {
	const { session, frames, settings } = await harness(true, {
		responses: [
			{ content: [], stopReason: "length", usage: { input: 100, output: 1000 } },
			{ content: ["Recovered answer"], usage: { input: 100 } },
		],
	});
	settings.override("compaction.methodOrder", ["window", "shake"]);
	settings.override("compaction.autoContinue", true);
	await session.prompt("Complete this task");
	await session.waitForIdle();
	expect(frames).toHaveLength(2);
	expect(session.messages.some(message => message.role === "assistant" && message.stopReason === "length")).toBe(
		false,
	);
	expect(JSON.stringify(session.messages)).toContain("Recovered answer");
}, 20000);

test("session_stop hooks receive public results without changing the journal or replay", async () => {
	const stops: string[] = [];
	const extensionRunner = {
		emit: async () => undefined,
		consumeToolCallEmitted: () => false,
		runScoped: <T>(run: () => T): T => run(),
		emitBeforeAgentStart: async () => undefined,
		hasHandlers: (event: string) => event === "session_stop",
		emitSessionStop: async (event: unknown) => {
			stops.push(JSON.stringify(event));
		},
	} as unknown as ExtensionRunner;
	const { session, manager, frames } = await harness(true, {
		extensionRunner,
		responses: [
			{
				content: [{ type: "toolCall", name: "notes.read_file", arguments: { path: "checkpoint" } }],
				usage: { input: 100 },
			},
			{ content: ["Finished"], usage: { input: 100 } },
		],
	});
	await session.prompt("Recover saved work");
	await session.waitForIdle();
	expect(stops).toHaveLength(1);
	expect(stops[0]).not.toContain("opaque-result");
	expect(stops[0]).toContain("[private model-only result]");
	expect(JSON.stringify(manager.getEntries())).toContain("opaque-result");
	expect(JSON.stringify(frames[1].messages)).toContain("opaque-result");
});

test("exhaustion rejects new_context without a checkpoint and uses the next compaction method", async () => {
	vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
		summary: "Recovered task checkpoint",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
	}));
	const { session, manager, frames } = await harness(true, {
		responses: [
			{ content: [{ type: "toolCall", name: "work", arguments: {} }], usage: { input: 8500 } },
			{ content: [{ type: "toolCall", name: "new_context", arguments: {} }], usage: { input: 9000 } },
			{ content: ["Finished"], usage: { input: 100 } },
		],
	});
	await session.prompt("Keep this task unless it has been checkpointed");
	await session.waitForIdle();
	expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "window")).toBe(false);
	expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "soft")).toBe(true);
	expect(JSON.stringify(frames.at(-1)?.messages)).toContain("Recovered task checkpoint");
});

test("intentional new_context before exhaustion does not require a checkpoint", async () => {
	const { session, manager } = await harness(true, {
		responses: [
			{ content: [{ type: "toolCall", name: "new_context", arguments: {} }], usage: { input: 100 } },
			{ content: ["Fresh context"], usage: { input: 100 } },
		],
	});
	await session.prompt("Start over intentionally");
	await session.waitForIdle();
	expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "window")).toBe(true);
});

test("aborting after new_context cancels the reset before a later prompt", async () => {
	const { session, manager, frames } = await harness(true, {
		responses: [
			{ content: [{ type: "toolCall", name: "new_context", arguments: {} }], usage: { input: 100 } },
			{ content: ["Aborted provider attempt"], usage: { input: 100 } },
			{ content: [{ type: "toolCall", name: "work", arguments: {} }], usage: { input: 100 } },
			{ content: ["Later task finished"], usage: { input: 100 } },
		],
	});
	let abort: Promise<void> | undefined;
	const unsubscribe = session.agent.subscribe(event => {
		if (event.type === "tool_execution_end" && event.toolName === "new_context") abort = session.abort();
	});
	await session.prompt("An interrupted reset");
	await abort;
	await session.waitForIdle();
	unsubscribe();
	expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "window")).toBe(false);
	await session.prompt("Keep this later task");
	await session.waitForIdle();
	expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "window")).toBe(false);
	expect(JSON.stringify(frames.at(-1)?.messages)).toContain("Keep this later task");
});

test.each(["tree", "branch", "switch"] as const)(
	"rehydrates the active branch window identity after %s",
	async boundary => {
		const { session, manager } = await harness(true);
		let expected = getOpenAICodexContextWindow(session.sessionId, session.providerSessionState);
		await session.prompt("Original branch task");
		await session.waitForIdle();
		expect(getOpenAICodexContextWindow(session.sessionId, session.providerSessionState).windowNumber).toBe(2);
		const original = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
		if (!original) throw new Error("Missing original user turn");
		if (boundary === "switch") {
			const other = SessionManager.create(manager.getCwd(), manager.getSessionDir());
			cleanups.push(() => other.close());
			expected = getOpenAICodexContextWindow(other.getSessionId(), new Map());
			other.appendCustomEntry("codex.context-window", { ...expected, agentPath: "/root" });
			await other.ensureOnDisk();
			const file = other.getSessionFile();
			if (!file) throw new Error("Missing target session file");
			expect(await session.switchSession(file)).toBe(true);
		} else if (boundary === "branch") {
			expect((await session.branch(original.id)).cancelled).toBe(false);
		} else {
			expect((await session.navigateTree(original.id, { summarize: false })).cancelled).toBe(false);
		}
		const projected = session.transformCodexContext({ messages: [] });
		const actual = getOpenAICodexContextWindow(session.sessionId, session.providerSessionState);
		expect(actual.threadId).toBe(expected.threadId);
		expect(actual.windowId).toBe(expected.windowId);
		expect(actual.windowNumber).toBe(1);
		expect(JSON.stringify(projected.messages)).toContain(expected.windowId);
	},
	20000,
);

test("remote compaction lineage survives restart in the next Codex request", async () => {
	vi.spyOn(compaction, "compact").mockImplementation(async preparation => ({
		summary: "Remote summary",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
	}));
	const { session, manager, settings, model } = await harness(true, {
		responses: [
			{ content: ["Earlier response"], usage: { input: 100 } },
			{ content: ["Recent response"], usage: { input: 100 } },
		],
	});
	settings.override("compaction.methodOrder", ["remote"]);
	settings.override("compaction.keepRecentTokens", 1);
	settings.override("compaction.remoteEndpoint", "https://compaction.invalid");
	await session.prompt("Earlier task ".repeat(200));
	await session.prompt("Recent task");
	await session.waitForIdle();
	const before = getOpenAICodexContextWindow(session.sessionId, session.providerSessionState);
	await session.compact();
	const rotated = getOpenAICodexContextWindow(session.sessionId, session.providerSessionState);
	expect(rotated.windowNumber).toBe(before.windowNumber + 1);
	expect(rotated.windowId).not.toBe(before.windowId);
	expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.method === "remote")).toBe(true);
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing compacted journal");
	await session.dispose();
	await manager.close();
	const resumed = await SessionManager.open(file);
	cleanups.push(() => resumed.close());
	const providerSessionState = new Map();
	const runtime = new CodexContextWindowRuntime({
		settings,
		sessionManager: resumed,
		providerSessionState,
		providerSessionId: () => resumed.getSessionId(),
		model: () => model,
		resolveAuth: async () => ({
			provider: model.provider,
			accessToken: token,
			accountId: "account",
			baseUrl: model.baseUrl,
		}),
		agentIdentity: { kind: "main", id: "Main" },
	});
	await runtime.refresh();
	runtime.transform({ messages: [] });
	const next = createOpenAICodexCompatibilityMetadata({
		sessionId: resumed.getSessionId(),
		providerSessionState,
		requestKind: "turn",
	});
	expect(JSON.parse(next.headers["x-codex-turn-metadata"])).toMatchObject({
		window_number: rotated.windowNumber,
		context_window_id: rotated.windowId,
	});
	expect(next.headers["x-codex-window-id"]).toBe(`${rotated.threadId}:${rotated.windowNumber}`);
});

test("a failed checkpoint write blocks the exhausted-window reset", async () => {
	const { session, manager, frames } = await harness(true, { notesWriteFails: true, windowOnly: true });
	await session.prompt("Original task must survive a failed checkpoint");
	await session.waitForIdle();
	const failedWrite = manager
		.getBranch()
		.some(
			entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "notes.write_file" &&
				entry.message.isError === true,
		);
	expect(failedWrite).toBe(true);
	expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
	expect(JSON.stringify(frames.at(-1)?.messages)).toContain("Original task must survive a failed checkpoint");
}, 20000);
