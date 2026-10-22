/**
 * Context returned by a `session.compacting` handler reaches every compaction
 * method, not only the LLM summarizers: snapcompact renders it into its
 * summary, and handoff sends it with the document request.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionMethod } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

const HOOK_CONTEXT = "Recalled memory: the deploy freeze stays in place until Friday.";
const HOOK_PRESERVE = { hookState: "keep-me" };
const FILLER = "The archived exchange keeps going with routine details. ".repeat(400);

describe("session.compacting context on snapcompact and handoff", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-compaction-hook-context-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model");
		model = bundled;
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function assistant(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	/** `beforeContext` runs inside the `session.compacting` handler before it returns. */
	function createSession(methodOrder: CompactionMethod[], beforeContext?: () => Promise<void>): AgentSession {
		sessionManager = SessionManager.inMemory(tempDir.path());
		sessionManager.appendMessage({ role: "user", content: `first question ${FILLER}`, timestamp: Date.now() });
		sessionManager.appendMessage(assistant(`first answer ${FILLER}`));
		sessionManager.appendMessage({ role: "user", content: "second question", timestamp: Date.now() });
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session.compacting"),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type !== "session.compacting") return undefined;
				await beforeContext?.();
				return { context: [HOOK_CONTEXT], preserveData: HOOK_PRESERVE };
			}),
			clearManagedTimers: vi.fn(),
		} as unknown as ExtensionRunner;
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
				"compaction.methodOrder": methodOrder,
			}),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	function latestCompaction(): CompactionEntry {
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		if (entry?.type !== "compaction") throw new Error("Expected a compaction entry");
		return entry;
	}

	/** Captures the handoff request instead of calling a provider. */
	function captureHandoffRequest() {
		return vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");
	}

	function expectSnapcompactCarriesContext(): void {
		const entry = latestCompaction();
		expect(entry.method).toBe("snapcompact");
		expect(entry.summary).toContain(HOOK_CONTEXT);
		expect(snapcompact.getPreservedArchive(entry.preserveData)?.context).toEqual([HOOK_CONTEXT]);
	}

	it("renders the context into a manual snapcompact summary", async () => {
		await createSession(["snapcompact"]).compact();
		expectSnapcompactCarriesContext();
	});

	it("renders the context into an automatic snapcompact summary", async () => {
		await createSession(["snapcompact"]).runIdleCompaction();
		expectSnapcompactCarriesContext();
	});

	it("sends the context with a manual handoff and commits the hook's preserveData", async () => {
		const request = captureHandoffRequest();
		await createSession(["handoff"]).handoff();

		expect(request).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(request.mock.calls[0]?.[0].messages)).toContain(HOOK_CONTEXT);
		expect(latestCompaction().preserveData).toMatchObject(HOOK_PRESERVE);
	});

	it("cancels a manual handoff aborted while session.compacting is running", async () => {
		const request = captureHandoffRequest();
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const active = createSession(["handoff"], async () => {
			hookStarted.resolve();
			await releaseHook.promise;
		});
		const pending = active.handoff();
		await hookStarted.promise;
		active.abortCompaction();
		releaseHook.resolve();

		await expect(pending).rejects.toThrow("Handoff cancelled");
		expect(request).not.toHaveBeenCalled();
		expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
	});

	it("sends the context with an automatic handoff", async () => {
		const request = captureHandoffRequest();
		await createSession(["handoff"]).runIdleCompaction();

		expect(request).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(request.mock.calls[0]?.[0].messages)).toContain(HOOK_CONTEXT);
		expect(latestCompaction().method).toBe("handoff");
	});
});
