import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// A hook-supplied native compaction that covers only the history before the
// kept tail must persist its replay boundary, or the rebuilt context drops the
// tail instead of replaying it after the native history.
describe("hook-provided compaction replay boundary", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage?.close();
	});

	it("persists and returns the boundary a session_before_compact hook reports", async () => {
		const sessionManager = SessionManager.inMemory();
		const assistant = (text: string, timestamp: number) => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 1000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		});
		sessionManager.appendMessage({ role: "user", content: "first request", timestamp: 1 });
		sessionManager.appendMessage(assistant("first answer", 2));
		sessionManager.appendMessage({ role: "user", content: "second request", timestamp: 3 });
		sessionManager.appendMessage(assistant("second answer", 4));

		let boundary: string | undefined;
		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				boundary = event.preparation.lastSummarizedEntryId;
				return {
					compaction: {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						preserveData: {
							openaiRemoteCompaction: {
								provider: "openai",
								replacementHistory: [{ type: "compaction", encrypted_content: "enc" }],
							},
						},
						providerReplayThroughEntryId: boundary,
					},
				};
			},
			emitBeforeAgentStart: async () => undefined,
		};
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: bundled, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1 }),
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});

		const result = await session.compact();

		expect(boundary).toBeDefined();
		expect(result.providerReplayThroughEntryId).toBe(boundary);
		const entry = sessionManager
			.getBranch()
			.findLast((candidate): candidate is CompactionEntry => candidate.type === "compaction");
		expect(entry?.providerReplayThroughEntryId).toBe(boundary);
	});
});
