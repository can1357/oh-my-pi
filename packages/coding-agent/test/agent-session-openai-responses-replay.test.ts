import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AssistantMessage,
	Message,
	ProviderPayload,
	ProviderSessionState,
	ToolResultMessage,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function createUsage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserHistoryPayload(provider = "openai"): ProviderPayload {
	return createOpenAIResponsesHistoryPayload(provider, [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user history" }] },
		{ type: "compaction", encrypted_content: "enc_preserved" },
	]);
}

function createStaleAssistantHistoryPayload(provider = "openai"): ProviderPayload {
	return createOpenAIResponsesHistoryPayload(provider, [
		{ type: "reasoning", encrypted_content: "enc_stale" },
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "msg_stale_snapshot",
			content: [{ type: "output_text", text: "Stale native snapshot" }],
		},
	]);
}

function createStaleAssistantMessage(
	text: string,
	options: { api?: AssistantMessage["api"]; provider?: string; model?: string } = {},
): AssistantMessage {
	const { api = "openai-responses", provider = "github-copilot", model = "gpt-5-mini" } = options;
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "Reasoning summary",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_stale",
					encrypted_content: "enc_stale",
				}),
			},
			{ type: "text", text, textSignature: "text_sig_preserved" },
			{
				type: "toolCall",
				id: "tool_call_1",
				name: "read",
				arguments: { path: "README.md" },
				thoughtSignature: "tool_sig_preserved",
			},
		],
		api,
		provider,
		model,
		usage: createUsage(),
		stopReason: "stop",
		providerPayload: createStaleAssistantHistoryPayload(provider),
		timestamp: Date.now(),
	};
}

/**
 * Matching tool result for the `tool_call_1` block emitted by
 * {@link createStaleAssistantMessage}. A real session always persists the
 * result alongside the assistant turn; without it the tool_use is dangling and
 * `buildSessionContext` strips it from the rebuilt LLM context.
 */
function createPairedToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool_call_1",
		toolName: "read",
		content: [{ type: "text", text: "README contents" }],
		isError: false,
		timestamp: Date.now(),
	};
}

/**
 * Persist a complete stale assistant turn: the assistant message followed by
 * its paired tool result so the tool_use is never dangling. Returns both entry
 * ids; the tool result is the turn's leaf.
 */
function appendStaleAssistantTurn(
	sessionManager: SessionManager,
	text: string,
	options: { api?: AssistantMessage["api"]; provider?: string; model?: string } = {},
): { assistantId: string; toolResultId: string } {
	const assistantId = sessionManager.appendMessage(createStaleAssistantMessage(text, options));
	const toolResultId = sessionManager.appendMessage(createPairedToolResult());
	return { assistantId, toolResultId };
}

function isSessionMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function getMessageEntries(sessionManager: SessionManager): SessionMessageEntry[] {
	return sessionManager.getEntries().filter(isSessionMessageEntry);
}

function getTextContent(message: Message): string | undefined {
	if (typeof message.content === "string") return message.content;
	for (const block of message.content) {
		if (block.type === "text") return block.text;
	}
	return undefined;
}

function findPersistedMessageEntry(
	sessionManager: SessionManager,
	role: Message["role"],
	text: string,
): SessionMessageEntry {
	const entry = getMessageEntries(sessionManager).find(candidate => {
		if (candidate.message.role !== role) return false;
		return getTextContent(candidate.message) === text;
	});
	if (!entry) {
		throw new Error(`Expected persisted ${role} message with text: ${text}`);
	}
	return entry;
}

function findRuntimeAssistant(session: AgentSession, text: string): AssistantMessage {
	const message = session.messages.find(
		candidate => candidate.role === "assistant" && getTextContent(candidate) === text,
	);
	if (message?.role !== "assistant") {
		throw new Error(`Expected runtime assistant message with text: ${text}`);
	}
	return message;
}

function expectAssistantReplayMetadataSanitized(message: AssistantMessage): void {
	// After rehydration, assistant Responses-family providerPayload must be stripped
	// to prevent stale native history replay on warmed sessions.
	expect(message.providerPayload).toBeUndefined();

	const thinkingBlock = message.content.find(block => block.type === "thinking");
	if (thinkingBlock?.type !== "thinking") {
		throw new Error("Expected assistant thinking block");
	}
	expect(thinkingBlock.thinkingSignature).toBeUndefined();

	const textBlock = message.content.find(block => block.type === "text");
	if (textBlock?.type !== "text") {
		throw new Error("Expected assistant text block");
	}
	expect(textBlock.textSignature).toBe("text_sig_preserved");

	const toolCallBlock = message.content.find(block => block.type === "toolCall");
	if (toolCallBlock?.type !== "toolCall") {
		throw new Error("Expected assistant tool call block");
	}
	expect(toolCallBlock).toMatchObject({
		id: "tool_call_1",
		name: "read",
		arguments: { path: "README.md" },
		thoughtSignature: "tool_sig_preserved",
	});
}

function expectAssistantReplayMetadataPreserved(message: AssistantMessage): void {
	// Non-Copilot Responses-family turns (OpenAI, OpenAI-Codex, Azure) keep their
	// native replay payload across rehydration so remote compaction can rebuild
	// faithful native history. The encrypted reasoning lives in
	// `providerPayload.items`; the per-block `thinkingSignature` was a byte-for-byte
	// duplicate of that reasoning item, so persistence drops it — the payload is the
	// durable copy replay actually reads.
	const payload = message.providerPayload;
	expect(payload?.type).toBe("openaiResponsesHistory");
	const reasoning =
		payload?.type === "openaiResponsesHistory"
			? payload.items.find(item => "type" in item && item.type === "reasoning")
			: undefined;
	expect(reasoning?.encrypted_content).toBe("enc_stale");

	const thinkingBlock = message.content.find(block => block.type === "thinking");
	if (thinkingBlock?.type !== "thinking") {
		throw new Error("Expected assistant thinking block");
	}
	expect(thinkingBlock.thinkingSignature).toBeUndefined();
}

async function createPersistedSession(
	tempDir: string,
	// Function-type union so callbacks that just mutate the SessionManager and
	// fall off the end (TS infers `() => void`) typecheck under TypeScript 5.x
	// alongside callbacks that explicitly return a tree target. TS 5.x does not
	// coerce a `void`-returning function value into a `() => T | undefined` slot
	// the way 6.x / tsgo does, so the two return shapes have to be siblings.
	populate:
		| ((sessionManager: SessionManager) => { treeTargetId?: string } | undefined)
		| ((sessionManager: SessionManager) => void),
): Promise<{ sessionFile: string; treeTargetId?: string }> {
	const sessionManager = SessionManager.create(tempDir, tempDir);
	const result = populate(sessionManager);
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new Error("Expected persisted session file");
	}
	await sessionManager.close();
	return { sessionFile, treeTargetId: result?.treeTargetId };
}

// ModelRegistry construction loads the bundled model catalog plus the on-disk
// cache (~100ms) and dominated this file's runtime when rebuilt once per test.
// The registry and its pinned AuthStorage are immutable across these tests (none
// mutate the catalog or stored credentials), so a single instance is shared via
// createAgentSession's `modelRegistry`/`authStorage` seam. The registry pins
// itself to its AuthStorage, so both MUST be the same shared instances.
let sharedModelRegistry: ModelRegistry;
let sharedRegistryDir: string;

async function createSessionHarness(
	tempDir: string,
	sessionManager: SessionManager,
	options: { provider?: Parameters<typeof getBundledModel>[0]; modelId?: string } = {},
): Promise<{ session: AgentSession }> {
	const { provider = "openai", modelId = "gpt-5-mini" } = options;
	const model = getBundledModel(provider, modelId);
	if (!model) {
		throw new Error(`Expected bundled test model ${provider}/${modelId}`);
	}

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage: sharedModelRegistry.authStorage,
		modelRegistry: sharedModelRegistry,
		sessionManager,
		model,
		// These tests seed bare `{ close }` stubs into `providerSessionState` and
		// assert reload closes them. The SDK's fire-and-forget Codex websocket
		// prewarm (models with `preferWebsockets`) would race in and replace the
		// stub via `getCodexProviderSessionState`, orphaning the spy — disable
		// websockets since these tests exercise reload semantics, not transport.
		settings: Settings.isolated({ "providers.openaiWebsockets": "off" }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		// These tests exercise session reload/sanitization/provider-state, never tool
		// execution, rule resolution, or the workspace-tree render. A minimal tool set
		// plus empty rules and a prebuilt (empty) workspace tree skip the per-call
		// startup scans (native listWorkspace + rule capability discovery) without
		// touching any asserted behavior.
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		toolNames: ["read"],
	});

	return { session };
}

describe("AgentSession OpenAI Responses replay boundaries", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: string[] = [];

	beforeAll(async () => {
		sharedRegistryDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-registry-${Snowflake.next()}-`));
		const authStorage = await AuthStorage.create(path.join(sharedRegistryDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		sharedModelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		sharedModelRegistry?.authStorage.close();
		if (sharedRegistryDir && fs.existsSync(sharedRegistryDir)) {
			removeSyncWithRetries(sharedRegistryDir);
		}
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir && fs.existsSync(tempDir)) {
				removeSyncWithRetries(tempDir);
			}
		}
	});

	it("sanitizes stale assistant replay metadata during startup resume while preserving user payloads", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-startup-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const preservedUserPayload = createUserHistoryPayload();
		const assistantText = "Loaded assistant response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendMessage({
				role: "user",
				content: "Preserved summary",
				providerPayload: preservedUserPayload,
				timestamp: Date.now() - 2,
			});
			appendStaleAssistantTurn(sessionManager, assistantText);
			sessionManager.appendMessage({ role: "user", content: "Follow-up", timestamp: Date.now() - 1 });
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createSessionHarness(tempDir, reloadedSessionManager);
		sessions.push(session);

		const persistedUser = findPersistedMessageEntry(session.sessionManager, "user", "Preserved summary").message;
		if (persistedUser.role !== "user") {
			throw new Error("Expected persisted user message");
		}
		expect(persistedUser.providerPayload).toEqual(preservedUserPayload);

		const persistedAssistant = findPersistedMessageEntry(session.sessionManager, "assistant", assistantText).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected persisted assistant message");
		}
		expectAssistantReplayMetadataSanitized(persistedAssistant);

		const runtimeAssistant = findRuntimeAssistant(session, assistantText);
		expectAssistantReplayMetadataSanitized(runtimeAssistant);
		const runtimeUser = session.messages.find(
			message => message.role === "user" && getTextContent(message) === "Preserved summary",
		);
		if (runtimeUser?.role !== "user") {
			throw new Error("Expected runtime user message");
		}
		expect(runtimeUser.providerPayload).toEqual(preservedUserPayload);
	});

	it("preserves codex assistant replay metadata for direct SessionManager.open consumers", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-open-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Codex assistant snapshot";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			appendStaleAssistantTurn(sessionManager, assistantText, {
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
			});
		});

		const openedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const persistedAssistant = findPersistedMessageEntry(openedSessionManager, "assistant", assistantText).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected persisted codex assistant message");
		}
		expectAssistantReplayMetadataPreserved(persistedAssistant);
		await openedSessionManager.close();
	});

	it("sanitizes stale assistant replay metadata when forking a persisted session", async () => {
		const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-fork-source-${Snowflake.next()}-`));
		const forkDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-fork-target-${Snowflake.next()}-`));
		tempDirs.push(sourceDir, forkDir);
		const preservedUserPayload = createUserHistoryPayload();
		const assistantText = "Forked assistant snapshot";

		const { sessionFile } = await createPersistedSession(sourceDir, sessionManager => {
			sessionManager.appendMessage({
				role: "user",
				content: "Fork summary",
				providerPayload: preservedUserPayload,
				timestamp: Date.now() - 2,
			});
			appendStaleAssistantTurn(sessionManager, assistantText);
		});

		const forkedSessionManager = await SessionManager.forkFrom(sessionFile, forkDir, forkDir);
		const forkedAssistant = findPersistedMessageEntry(forkedSessionManager, "assistant", assistantText).message;
		if (forkedAssistant.role !== "assistant") {
			throw new Error("Expected forked assistant message");
		}
		expectAssistantReplayMetadataSanitized(forkedAssistant);

		const forkedUser = findPersistedMessageEntry(forkedSessionManager, "user", "Fork summary").message;
		if (forkedUser.role !== "user") {
			throw new Error("Expected forked user message");
		}
		expect(forkedUser.providerPayload).toEqual(preservedUserPayload);
		await forkedSessionManager.close();
	});

	it("keeps same-file reload safe without resetting live provider state after startup sanitization", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded assistant response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.5");
			sessionManager.appendMessage({ role: "user", content: "Reload summary", timestamp: Date.now() - 2 });
			appendStaleAssistantTurn(sessionManager, assistantText, {
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
			});
			sessionManager.appendMessage({ role: "user", content: "Reload follow-up", timestamp: Date.now() - 1 });
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.5",
		});
		sessions.push(session);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		await session.reload();

		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
		expectAssistantReplayMetadataPreserved(findRuntimeAssistant(session, assistantText));

		const persistedAssistant = findPersistedMessageEntry(session.sessionManager, "assistant", assistantText).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected reloaded assistant message");
		}
		expectAssistantReplayMetadataPreserved(persistedAssistant);
	});

	it("keeps provider session state when same-file reload only changes message metadata", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-metadata-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded metadata-only response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.5");
			appendStaleAssistantTurn(sessionManager, assistantText, {
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
			});
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.5",
		});
		sessions.push(session);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		const rewrittenLines = fs
			.readFileSync(sessionFile, "utf8")
			.trimEnd()
			.split("\n")
			.map(line => {
				const entry = JSON.parse(line) as { type?: string; message?: { role?: string; timestamp?: number } };
				if (entry.type === "message" && entry.message?.role === "assistant") {
					entry.message.timestamp = (entry.message.timestamp ?? 0) + 10_000;
				}
				return JSON.stringify(entry);
			});
		fs.writeFileSync(sessionFile, `${rewrittenLines.join("\n")}\n`, "utf8");

		await session.reload();

		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
		expect(session.model?.provider).toBe("openai-codex");
		expect(session.model?.id).toBe("gpt-5.5");
		expectAssistantReplayMetadataPreserved(findRuntimeAssistant(session, assistantText));
	});

	it("captures session-manager state when custom message details are proxy-backed", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-capture-proxy-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const proxyDetails = new Proxy({ ok: true, nested: { value: "preserved" } }, {});

		sessionManager.appendCustomMessageEntry("proxy-details", "Proxy metadata", true, proxyDetails);

		const snapshot = sessionManager.captureState();
		const customEntry = snapshot.entries.find(
			entry => entry.type === "custom_message" && entry.customType === "proxy-details",
		);
		if (customEntry?.type !== "custom_message") {
			throw new Error("Expected captured custom message entry");
		}
		expect(customEntry.details).toEqual({ ok: true, nested: { value: "preserved" } });
		await sessionManager.close();
	});

	it("reloads when current session contains proxy-backed custom message details", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-proxy-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const { session } = await createSessionHarness(tempDir, sessionManager);
		sessions.push(session);
		const proxyDetails = new Proxy({ ok: true, nested: { value: "preserved" } }, {});

		await session.sendCustomMessage(
			{
				customType: "proxy-details",
				content: "Proxy metadata",
				display: true,
				details: proxyDetails,
			},
			{ triggerTurn: false },
		);

		const originalSessionFile = session.sessionFile;
		expect(originalSessionFile).toBeDefined();

		await session.reload();

		expect(session.sessionFile).toBe(originalSessionFile);
	});

	it("resets provider session state when same-file reload restores different messages under the same model", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-content-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded content change response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.5");
			appendStaleAssistantTurn(sessionManager, assistantText, {
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
			});
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.5",
		});
		sessions.push(session);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		const mutatedSessionManager = await SessionManager.open(sessionFile, tempDir);
		mutatedSessionManager.appendMessage({
			role: "user",
			content: "Externally appended follow-up",
			timestamp: Date.now() + 1,
		});
		await mutatedSessionManager.flush();
		await mutatedSessionManager.close();

		await session.reload();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
		expect(session.model?.provider).toBe("openai-codex");
		expect(session.model?.id).toBe("gpt-5.5");
		expect(
			session.messages.some(
				message => message.role === "user" && getTextContent(message) === "Externally appended follow-up",
			),
		).toBe(true);
	});

	it("resets provider session state when same-file reload restores a different saved model", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-model-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded model change response";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai-codex/gpt-5.5");
			appendStaleAssistantTurn(sessionManager, assistantText, {
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
			});
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createSessionHarness(tempDir, reloadedSessionManager, {
			provider: "openai-codex",
			modelId: "gpt-5.5",
		});
		sessions.push(session);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		const mutatedSessionManager = await SessionManager.open(sessionFile, tempDir);
		mutatedSessionManager.appendModelChange("openai/gpt-5-mini");
		await mutatedSessionManager.flush();
		expect(mutatedSessionManager.buildSessionContext().models.default).toBe("openai/gpt-5-mini");
		await mutatedSessionManager.close();

		await session.reload();

		expect(session.model?.provider).toBe("openai");
		expect(session.model?.id).toBe("gpt-5-mini");
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
		expectAssistantReplayMetadataPreserved(findRuntimeAssistant(session, assistantText));
	});

	it("resets plain openai-responses provider state when same-file reload restores a different saved model", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-reload-openai-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const assistantText = "Reloaded openai responses model change";

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendModelChange("openai/gpt-5-mini");
			appendStaleAssistantTurn(sessionManager, assistantText);
		});

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createSessionHarness(tempDir, reloadedSessionManager);
		sessions.push(session);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", { close: closeSpy } satisfies ProviderSessionState);

		const mutatedSessionManager = await SessionManager.open(sessionFile, tempDir);
		mutatedSessionManager.appendModelChange("openai/gpt-5.4-mini");
		await mutatedSessionManager.flush();
		expect(mutatedSessionManager.buildSessionContext().models.default).toBe("openai/gpt-5.4-mini");
		await mutatedSessionManager.close();

		await session.reload();

		expect(session.model?.provider).toBe("openai");
		expect(session.model?.id).toBe("gpt-5.4-mini");
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, assistantText));
	});

	it("switches sessions without requiring write access during load-time sanitization", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-switch-fail-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const currentSessionManager = SessionManager.create(tempDir, tempDir);
		const { session } = await createSessionHarness(tempDir, currentSessionManager);
		sessions.push(session);

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			appendStaleAssistantTurn(sessionManager, "Unreadable assistant snapshot");
		});
		const sessionDir = path.dirname(sessionFile);
		const originalMode = fs.statSync(sessionDir).mode & 0o777;
		fs.chmodSync(sessionDir, 0o555);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", { close: closeSpy } satisfies ProviderSessionState);

		try {
			await expect(session.switchSession(sessionFile)).resolves.toBe(true);
		} finally {
			fs.chmodSync(sessionDir, originalMode);
		}

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
		expect(session.sessionManager).toBe(currentSessionManager);
		expect(session.sessionFile).toBe(sessionFile);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, "Unreadable assistant snapshot"));
	});

	it("clears provider session state and sanitizes loaded assistant metadata when switching sessions", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-switch-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const preservedUserPayload = createUserHistoryPayload();
		const assistantText = "Switched assistant response";

		const currentSessionManager = SessionManager.create(tempDir, tempDir);
		const { session } = await createSessionHarness(tempDir, currentSessionManager);
		sessions.push(session);

		const { sessionFile } = await createPersistedSession(tempDir, sessionManager => {
			sessionManager.appendMessage({
				role: "user",
				content: "Older summary",
				providerPayload: preservedUserPayload,
				timestamp: Date.now() - 2,
			});
			appendStaleAssistantTurn(sessionManager, assistantText);
			sessionManager.appendMessage({ role: "user", content: "Older follow-up", timestamp: Date.now() - 1 });
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("stale-provider-session", { close: closeSpy } satisfies ProviderSessionState);

		const switched = await session.switchSession(sessionFile);
		expect(switched).toBe(true);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);

		const persistedAssistant = findPersistedMessageEntry(session.sessionManager, "assistant", assistantText).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected persisted assistant message after switch");
		}
		expectAssistantReplayMetadataSanitized(persistedAssistant);
		const persistedUser = findPersistedMessageEntry(session.sessionManager, "user", "Older summary").message;
		if (persistedUser.role !== "user") {
			throw new Error("Expected switched user message");
		}
		expect(persistedUser.providerPayload).toEqual(preservedUserPayload);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, assistantText));
	});

	it("does not reintroduce stale assistant replay metadata when navigating to another branch after load sanitization", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-tree-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const branchAssistantText = "Archived branch assistant";

		const { sessionFile, treeTargetId } = await createPersistedSession(tempDir, sessionManager => {
			const rootUserId = sessionManager.appendMessage({ role: "user", content: "Root", timestamp: Date.now() - 5 });
			const mainAssistantId = sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Main branch" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5-mini",
				usage: createUsage(),
				stopReason: "stop",
				timestamp: Date.now() - 4,
			});
			sessionManager.branch(rootUserId);
			sessionManager.appendMessage({ role: "user", content: "Archived branch", timestamp: Date.now() - 3 });
			const { toolResultId: archivedTurnLeafId } = appendStaleAssistantTurn(sessionManager, branchAssistantText);
			sessionManager.branch(mainAssistantId);
			sessionManager.appendMessage({ role: "user", content: "Active branch leaf", timestamp: Date.now() - 2 });
			return { treeTargetId: archivedTurnLeafId };
		});

		if (!treeTargetId) {
			throw new Error("Expected archived branch target id");
		}

		const reloadedSessionManager = await SessionManager.open(sessionFile, tempDir);
		const { session } = await createSessionHarness(tempDir, reloadedSessionManager);
		sessions.push(session);

		const navigation = await session.navigateTree(treeTargetId, { summarize: false });
		expect(navigation.cancelled).toBe(false);
		expectAssistantReplayMetadataSanitized(findRuntimeAssistant(session, branchAssistantText));

		const persistedAssistant = findPersistedMessageEntry(
			session.sessionManager,
			"assistant",
			branchAssistantText,
		).message;
		if (persistedAssistant.role !== "assistant") {
			throw new Error("Expected archived branch assistant entry");
		}
		expectAssistantReplayMetadataSanitized(persistedAssistant);
	});

	it("resets provider session state when starting a brand-new session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-issue-505-new-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const { session } = await createSessionHarness(tempDir, sessionManager);
		sessions.push(session);

		const closeSpy = vi.fn();
		session.providerSessionState.set("live-provider-session", { close: closeSpy } satisfies ProviderSessionState);

		const created = await session.newSession();
		expect(created).toBe(true);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});
});
