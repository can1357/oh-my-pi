import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ApiKeyResolveContext, AssistantMessage, AssistantRetryRecovery, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveAssistantErrorPresentation } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

type RecoveryRun = {
	session: AgentSession;
	sessionManager: SessionManager;
	retryEndEvents: AutoRetryEndEvent[];
	requestedKeys: string[];
};

const RATE_LIMIT_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';
const RETRIABLE_SERVER_ERROR = "503 service unavailable: overloaded_error";

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function retryRecovery(recovery: AssistantRetryRecovery["recovery"], note: string): AssistantRetryRecovery {
	return {
		kind: "auto-retry",
		status: "recovered",
		attempt: 1,
		recoveredAt: "2026-07-04T00:00:00.000Z",
		recovery,
		note,
	};
}

function resolveInitialApiKey(
	apiKey: string | ((ctx: ApiKeyResolveContext) => string | Promise<string | undefined> | undefined) | undefined,
): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	if (typeof resolved !== "string") {
		throw new Error("Expected API key to be resolved before streaming");
	}
	return resolved;
}

interface AssistantEntry {
	entry: SessionMessageEntry;
	message: AssistantMessage;
}

function assistantEntries(sessionManager: SessionManager): AssistantEntry[] {
	const result: AssistantEntry[] = [];
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		result.push({ entry, message });
	}
	return result;
}

function recoveredAssistantEntry(sessionManager: SessionManager): AssistantEntry {
	const found = assistantEntries(sessionManager).find(
		candidate => candidate.message.retryRecovery?.status === "recovered",
	);
	if (!found) {
		throw new Error("Expected a recovered assistant entry");
	}
	return found;
}

function successfulAssistantEntry(sessionManager: SessionManager, text: string): AssistantEntry {
	const found = assistantEntries(sessionManager).find(candidate =>
		candidate.message.content.some(block => block.type === "text" && block.text === text),
	);
	if (!found) {
		throw new Error(`Expected successful assistant entry containing ${text}`);
	}
	return found;
}

describe("AgentSession retry recovery", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let managers: SessionManager[];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-retry-recovery-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-recovery-");
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		await authStorage.remove("anthropic");
		authStorage.removeRuntimeApiKey("anthropic");
		modelRegistry.clearSuppressedSelectors();
		sessions = [];
		managers = [];
	});

	afterEach(async () => {
		for (const activeSession of sessions.splice(0).reverse()) {
			await activeSession.dispose();
		}
		for (const manager of managers.splice(0).reverse()) {
			await manager.close();
		}
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	async function runCredentialRecovery(): Promise<RecoveryRun> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);

		const mock = createMockModel();
		const requestedKeys: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const apiKey = resolveInitialApiKey(options?.apiKey);
				requestedKeys.push(apiKey);
				if (requestedKeys.length === 1) {
					mock.push({ throw: RATE_LIMIT_ERROR });
				} else {
					mock.push({ content: ["recovered after credential switch"], stopReason: "stop" });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger account rate limit recovery");
		await session.waitForIdle();
		await sessionManager.flush();

		return { session, sessionManager, retryEndEvents, requestedKeys };
	}

	it("marks a recovered retry error, emits it, persists it, and excludes only model-context replay", async () => {
		const { sessionManager, retryEndEvents, requestedKeys } = await runCredentialRecovery();

		expect(new Set(requestedKeys)).toEqual(new Set(["anthropic-key-1", "anthropic-key-2"]));
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(retryEndEvents[0].retryErrors).toHaveLength(1);

		const recoveredEntry = recoveredAssistantEntry(sessionManager);
		const successfulEntry = successfulAssistantEntry(sessionManager, "recovered after credential switch");
		const recoveredEvent = retryEndEvents[0].retryErrors?.[0];
		if (!recoveredEvent) {
			throw new Error("Expected a recovered error payload on auto_retry_end");
		}
		const recoveredMarker = recoveredEntry.message.retryRecovery;
		if (recoveredMarker?.status !== "recovered") {
			throw new Error("Expected recovered marker on superseded assistant message");
		}
		expect(recoveredEvent.entryId).toBe(recoveredEntry.entry.id);
		expect(recoveredEvent.persistenceKey).toBeString();
		expect(recoveredEvent.note).toBe("rate-limited; switched account; retried");
		expect(recoveredEvent.retryRecovery).toEqual(recoveredMarker);
		expect(recoveredEntry.message.stopReason).toBe("error");
		expect(recoveredEntry.message.retryRecovery).toMatchObject({
			kind: "auto-retry",
			status: "recovered",
			attempt: 1,
			recovery: "credential",
			note: "rate-limited; switched account; retried",
			supersededBy: {
				provider: successfulEntry.message.provider,
				model: successfulEntry.message.model,
				timestamp: successfulEntry.message.timestamp,
			},
		});
		expect(Date.parse(recoveredMarker.recoveredAt)).not.toBeNaN();

		const modelContext = sessionManager.buildSessionContext();
		expect(modelContext.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(
			modelContext.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(modelContext.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after credential switch" }],
		});

		const transcriptContext = sessionManager.buildSessionContext({ transcript: true });
		expect(transcriptContext.messages.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
		expect(
			transcriptContext.messages.some(
				message => message.role === "assistant" && message.retryRecovery?.status === "recovered",
			),
		).toBe(true);
	});

	it("collapses exhausted retries into one terminal error naming the spent budget", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");

		const mock = createMockModel({
			responses: [{ throw: RETRIABLE_SERVER_ERROR }, { throw: RETRIABLE_SERVER_ERROR }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Exhaust retry attempts");
		await session.waitForIdle();
		await sessionManager.flush();

		expect(mock.calls).toHaveLength(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false, attempt: 1 });
		expect(retryEndEvents[0].retryErrors).toHaveLength(1);
		expect(retryEndEvents[0].retryErrors?.[0].retryRecovery).toMatchObject({
			status: "superseded",
			attempt: 1,
		});

		const errors = assistantEntries(sessionManager).filter(candidate => candidate.message.stopReason === "error");
		expect(errors).toHaveLength(2);
		expect(errors[0].message.retryRecovery).toMatchObject({ status: "superseded", attempt: 1 });
		expect(resolveAssistantErrorPresentation(errors[0].message)).toEqual({ kind: "none" });

		const terminalError = errors[1].message;
		const terminalErrorText = terminalError.errorMessage;
		if (!terminalErrorText) {
			throw new Error("Expected an aggregated terminal error message");
		}
		expect(terminalError.retryRecovery).toBeUndefined();
		expect(terminalErrorText).toBe(`Retry budget exhausted after 1 retry: ${RETRIABLE_SERVER_ERROR}`);
		expect(resolveAssistantErrorPresentation(terminalError)).toEqual({
			kind: "full",
			text: terminalErrorText,
			isError: true,
		});

		const visibleErrors = errors
			.map(candidate => resolveAssistantErrorPresentation(candidate.message))
			.filter(presentation => presentation.kind !== "none");
		expect(visibleErrors).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages.map(message => message.role)).toEqual(["user"]);
	});

	it("maps assistant error presentation for recovered, unrecovered, and silent abort turns", () => {
		const recoveredCases: Array<{
			name: string;
			recovery: AssistantRetryRecovery["recovery"];
			note: string;
		}> = [
			{ name: "credential", recovery: "credential", note: "rate-limited; switched account; retried" },
			{ name: "model", recovery: "model", note: "rate-limited; switched model; retried" },
			{ name: "wait", recovery: "wait", note: "rate-limited; waited; retried" },
			{ name: "plain", recovery: "plain", note: "error; retried" },
		];

		for (const testCase of recoveredCases) {
			expect(
				resolveAssistantErrorPresentation(
					assistantMessage({
						stopReason: "error",
						errorMessage: `${testCase.name} retry was superseded`,
						retryRecovery: retryRecovery(testCase.recovery, testCase.note),
					}),
				),
			).toEqual({ kind: "compact-recovered", text: testCase.note, isError: false });
		}

		expect(
			resolveAssistantErrorPresentation(
				assistantMessage({ stopReason: "error", errorMessage: "503 service unavailable" }),
			),
		).toEqual({ kind: "full", text: "503 service unavailable", isError: true });
		expect(
			resolveAssistantErrorPresentation(
				assistantMessage({ stopReason: "aborted", errorMessage: SILENT_ABORT_MARKER }),
			),
		).toEqual({ kind: "none" });
	});

	it("keeps recovered markers durable across session reload and still excludes them from model context", async () => {
		const { sessionManager } = await runCredentialRecovery();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected recovery run to persist a session file");
		}

		const reloadedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"), undefined, {
			suppressBreadcrumb: true,
		});
		managers.push(reloadedManager);
		const recoveredEntry = recoveredAssistantEntry(reloadedManager);
		expect(recoveredEntry.message.retryRecovery).toMatchObject({
			kind: "auto-retry",
			status: "recovered",
			recovery: "credential",
			note: "rate-limited; switched account; retried",
		});

		const modelContext = reloadedManager.buildSessionContext();
		expect(modelContext.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(
			modelContext.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(modelContext.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after credential switch" }],
		});
	});
});
