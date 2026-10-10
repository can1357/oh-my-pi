import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const primary = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const fallback = getBundledModel("openai", "gpt-4o-mini")!;
const secondFallback = getBundledModel("openai", "gpt-4o")!;
const selector = (model: Model) => `${model.provider}/${model.id}`;

function compacted(preparation: compactionModule.CompactionPreparation): compactionModule.CompactionResult {
	return {
		summary: "Earlier work is summarized; continue with the retained conversation.",
		shortSummary: undefined,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
	};
}

describe("compaction releases primary-session refusal fallback pins", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let compactMock: Mock<typeof compactionModule.compact>;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-compaction-refusal-release-");
		await initTheme();
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
		compactMock = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation(async preparation => compacted(preparation));
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		options: {
			refusals?: number;
			refusalModel?: Model;
			revertPolicy?: "cooldown-expiry" | "never";
			usageAware?: boolean;
			initialUsagePin?: boolean;
		} = {},
	): string[] {
		const requestedModels: string[] = [];
		const mock = createMockModel();
		let refusalsRemaining = options.refusals ?? 1;
		const refusalModel = options.refusalModel ?? primary;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: options.initialUsagePin ? fallback : primary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, streamOptions) => {
				requestedModels.push(selector(model));
				if (selector(model) === selector(refusalModel) && refusalsRemaining > 0) {
					refusalsRemaining--;
					mock.push({
						content: [{ type: "thinking", thinking: "Classifier evaluation." }],
						stopReason: "error",
						stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined this turn." },
						errorMessage: "Refusal (cyber): Classifier declined this turn.",
					});
				} else {
					mock.push({ content: [`Completed work on ${selector(model)}.`] });
				}
				return mock.stream(model, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { default: [selector(fallback), selector(secondFallback)] },
			"retry.fallbackRevertPolicy": options.revertPolicy ?? "cooldown-expiry",
			"retry.usageAwareFallback": options.usageAware ?? false,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			initialRetryFallback: options.initialUsagePin
				? { role: "default", originalSelector: selector(primary), originalThinkingLevel: undefined, pinned: true }
				: undefined,
		});
		return requestedModels;
	}

	async function prompt(text: string): Promise<void> {
		await session.prompt(text);
		await session.waitForIdle();
	}

	async function buildPinnedHistory(): Promise<void> {
		await prompt("Recover on an eligible fallback.");
		await prompt("Continue before compaction.");
	}

	async function compact(): Promise<void> {
		await session.compact();
		expect(session.messages[0]?.role).toBe("compactionSummary");
	}

	it("keeps refusal fallback between prompts, then requests the primary after committed compaction", async () => {
		const requests = createSession();
		await buildPinnedHistory();
		expect(requests).toEqual([selector(primary), selector(fallback), selector(fallback)]);

		await compact();
		expect(selector(session.model!)).toBe(selector(fallback));
		expect(requests).toEqual([selector(primary), selector(fallback), selector(fallback)]);
		await prompt("Try the rewritten context on the primary.");
		expect(requests).toEqual([selector(primary), selector(fallback), selector(fallback), selector(primary)]);
	});

	it("releases refusal pins after automatic compaction commits", async () => {
		const requests = createSession();
		await buildPinnedHistory();
		await session.runIdleCompaction();
		await session.waitForIdle();
		expect(session.messages[0]?.role).toBe("compactionSummary");
		expect(selector(session.model!)).toBe(selector(fallback));
		await prompt("Retry the primary after automatic compaction.");
		expect(requests).toEqual([selector(primary), selector(fallback), selector(fallback), selector(primary)]);
	});

	it("keeps a usage-aware pin after compaction even when primary usage recovers", async () => {
		const requests = createSession({ refusals: 0, usageAware: true });
		let depleted = true;
		vi.spyOn(authStorage.health, "model").mockImplementation(async provider =>
			depleted && provider === primary.provider
				? {
						state: "depleted",
						accounts: [
							{ credentialId: 1, credentialType: "oauth", state: "depleted", resetsAt: Date.now() + 60_000 },
						],
					}
				: { state: "healthy", accounts: [] },
		);
		await buildPinnedHistory();
		depleted = false;
		await compact();
		await prompt("Keep the usage-selected fallback.");
		expect(requests).toEqual([selector(fallback), selector(fallback), selector(fallback)]);
	});

	it("preserves startup usage pins when a later refusal adds a second pin reason", async () => {
		const requests = createSession({ initialUsagePin: true, refusalModel: fallback });
		await buildPinnedHistory();
		expect(requests).toEqual([selector(fallback), selector(secondFallback), selector(secondFallback)]);
		await compact();
		await prompt("Keep the fallback pinned for usage despite releasing the refusal pin.");
		expect(requests).toEqual([
			selector(fallback),
			selector(secondFallback),
			selector(secondFallback),
			selector(secondFallback),
		]);
	});

	it("honors the never revert policy after compaction", async () => {
		const requests = createSession({ revertPolicy: "never" });
		await buildPinnedHistory();
		await compact();
		await prompt("Keep the fallback under the never policy.");
		expect(requests).toEqual([selector(primary), selector(fallback), selector(fallback), selector(fallback)]);
	});

	it("leaves a refusal fallback pinned when compaction fails", async () => {
		const requests = createSession();
		await buildPinnedHistory();
		compactMock.mockRejectedValue(new Error("Summarization failed."));
		await expect(session.compact()).rejects.toThrow("Summarization failed.");
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
		await prompt("Continue after failed compaction.");
		expect(requests).toEqual([selector(primary), selector(fallback), selector(fallback), selector(fallback)]);
	});

	it("leaves a refusal fallback pinned when compaction is cancelled before commit", async () => {
		const requests = createSession();
		await buildPinnedHistory();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		compactMock.mockImplementation(async preparation => {
			started.resolve();
			await release.promise;
			return compacted(preparation);
		});
		const pending = session.compact();
		await started.promise;
		session.abortCompaction();
		release.resolve();
		await expect(pending).rejects.toBeInstanceOf(compactionModule.CompactionCancelledError);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
		await prompt("Continue after cancelled compaction.");
		expect(requests).toEqual([selector(primary), selector(fallback), selector(fallback), selector(fallback)]);
	});

	it("pins the fallback again if the restored primary refuses without adding a retry loop", async () => {
		const requests = createSession({ refusals: 2 });
		await buildPinnedHistory();
		await compact();
		await prompt("The restored primary refuses again.");
		await prompt("The new refusal keeps this prompt on the fallback.");
		expect(requests).toEqual([
			selector(primary),
			selector(fallback),
			selector(fallback),
			selector(primary),
			selector(fallback),
			selector(fallback),
		]);
		await compact();
		await prompt("A later compaction permits another primary attempt.");
		expect(requests.at(-1)).toBe(selector(primary));
		expect(requests).toHaveLength(7);
	});
});
