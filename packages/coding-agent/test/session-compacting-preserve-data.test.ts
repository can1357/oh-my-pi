import { describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("session.compacting preserveData", () => {
	it("merges session.compacting preserveData from every handler", async () => {
		const tempDir = TempDir.createSync("@pi-compacting-merge-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const extensionA = await loadExtensionFromFactory(
				pi => {
					pi.on("session.compacting", async () => ({
						prompt: "custom prompt",
						preserveData: { extA: { version: 1 } },
					}));
				},
				tempDir.path(),
				new EventBus(),
				new ExtensionRuntime(),
				"compacting-a",
			);
			const extensionB = await loadExtensionFromFactory(
				pi => {
					pi.on("session.compacting", async () => ({
						context: ["keep note"],
						preserveData: { extB: { version: 2 } },
					}));
				},
				tempDir.path(),
				new EventBus(),
				new ExtensionRuntime(),
				"compacting-b",
			);
			const extensionRunner = new ExtensionRunner(
				[extensionA, extensionB],
				new ExtensionRuntime(),
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const result = await extensionRunner.emit({
				type: "session.compacting",
				sessionId: "s",
				messages: [],
			});

			expect(result).toEqual({
				prompt: "custom prompt",
				context: ["keep note"],
				preserveData: { extA: { version: 1 }, extB: { version: 2 } },
			});
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	it("keeps fresh session.compacting preserveData over stale carried-over keys", async () => {
		const localTempDir = TempDir.createSync("@pi-compacting-fresh-");
		const localSessionManager = SessionManager.inMemory(localTempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		const firstKeptEntryId = localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session.compacting", async () => ({ preserveData: { shared: "fresh" } }));
			},
			localTempDir.path(),
			new EventBus(),
			new ExtensionRuntime(),
			"compacting-fresh",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			localTempDir.path(),
			localSessionManager,
			modelRegistry,
		);
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "context-full summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
			preserveData: { shared: "stale" },
		});
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
			}),
			modelRegistry,
			extensionRunner,
		});

		try {
			await localSession.compact();
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({ shared: "fresh" });
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
			authStorage.close();
			vi.restoreAllMocks();
		}
	});

	it("keeps session.compacting preserveData through a manual handoff", async () => {
		const localTempDir = TempDir.createSync("@pi-compacting-handoff-");
		const localSessionManager = SessionManager.create(localTempDir.path(), localTempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		localSessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session.compacting", async () => ({ preserveData: { handoffState: "keep-me" } }));
			},
			localTempDir.path(),
			new EventBus(),
			new ExtensionRuntime(),
			"compacting-handoff",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			localTempDir.path(),
			localSessionManager,
			modelRegistry,
		);
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm: compactionModule.defaultConvertToLlm,
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
			extensionRunner,
		});

		try {
			vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");
			await localSession.compact(undefined, { mode: "handoff" });
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({ handoffState: "keep-me" });
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
			authStorage.close();
			vi.restoreAllMocks();
		}
	});

	it("keeps an earlier handler prompt and context when a later handler returns them as undefined", async () => {
		const tempDir = TempDir.createSync("@pi-compacting-undefined-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const extensionA = await loadExtensionFromFactory(
				pi => {
					pi.on("session.compacting", async () => ({
						prompt: "first prompt",
						context: ["first context"],
						preserveData: { extA: "a" },
					}));
				},
				tempDir.path(),
				new EventBus(),
				new ExtensionRuntime(),
				"compacting-undefined-a",
			);
			const extensionB = await loadExtensionFromFactory(
				pi => {
					pi.on("session.compacting", async () => ({
						prompt: undefined,
						context: undefined,
						preserveData: { extB: "b" },
					}));
				},
				tempDir.path(),
				new EventBus(),
				new ExtensionRuntime(),
				"compacting-undefined-b",
			);
			const extensionRunner = new ExtensionRunner(
				[extensionA, extensionB],
				new ExtensionRuntime(),
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const result = await extensionRunner.emit({
				type: "session.compacting",
				sessionId: "s",
				messages: [],
			});

			expect(result?.prompt).toBe("first prompt");
			expect(result?.context).toEqual(["first context"]);
			expect(result?.preserveData).toEqual({ extA: "a", extB: "b" });
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	it("lets a later handler explicit empty context array replace an earlier context", async () => {
		const tempDir = TempDir.createSync("@pi-compacting-empty-context-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const extensionA = await loadExtensionFromFactory(
				pi => {
					pi.on("session.compacting", async () => ({
						context: ["first context"],
					}));
				},
				tempDir.path(),
				new EventBus(),
				new ExtensionRuntime(),
				"compacting-empty-context-a",
			);
			const extensionB = await loadExtensionFromFactory(
				pi => {
					pi.on("session.compacting", async () => ({
						context: [],
					}));
				},
				tempDir.path(),
				new EventBus(),
				new ExtensionRuntime(),
				"compacting-empty-context-b",
			);
			const extensionRunner = new ExtensionRunner(
				[extensionA, extensionB],
				new ExtensionRuntime(),
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const result = await extensionRunner.emit({
				type: "session.compacting",
				sessionId: "s",
				messages: [],
			});

			expect(result?.context).toEqual([]);
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	it("drops provider compaction replay and snapcompact archive keys a session.compacting hook returns", async () => {
		const localTempDir = TempDir.createSync("@pi-compacting-filter-");
		const localSessionManager = SessionManager.inMemory(localTempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		const firstKeptEntryId = localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session.compacting", async () => ({
					preserveData: {
						openaiRemoteCompaction: { id: "remote" },
						anthropicCompaction: { id: "native" },
						snapcompact: { frames: [] },
						keep: "kept",
					},
				}));
			},
			localTempDir.path(),
			new EventBus(),
			new ExtensionRuntime(),
			"compacting-filter",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			localTempDir.path(),
			localSessionManager,
			modelRegistry,
		);
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "context-full summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
		});
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
			}),
			modelRegistry,
			extensionRunner,
		});

		try {
			await localSession.compact();
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({ keep: "kept" });
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
			authStorage.close();
			vi.restoreAllMocks();
		}
	});
});
