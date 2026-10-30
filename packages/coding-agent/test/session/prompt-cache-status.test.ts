import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgProvidersCacheWarming } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHORT_TTL_MS = 300_000;
/** 90% of the 5-minute lifetime: when the warmer refreshes. */
const REFRESH_DELAY_MS = 270_000;

function usage(tokens: Partial<Pick<Usage, "cacheRead" | "cacheWrite" | "cttl">>): Usage {
	const cacheRead = tokens.cacheRead ?? 0;
	const cacheWrite = tokens.cacheWrite ?? 0;
	return {
		input: 1,
		output: 1,
		cacheRead,
		cacheWrite,
		totalTokens: 2 + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(tokens.cttl ? { cttl: tokens.cttl } : {}),
	};
}

function reply(model: Model, replyUsage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: replyUsage,
	};
}

describe("AgentSession prompt-cache status", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let settings: Settings;
	let session: AgentSession;
	let warmer: CacheWarmer;
	let model: Model;
	/** What a warm refresh reads back: a hit by default. */
	let refreshUsage: Usage;

	async function createSession(sessionModel: Model): Promise<void> {
		warmer?.cancel();
		authStorage?.close();
		const agentDir = tempDir.path();
		const storage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage = storage;
		storage.keys.setRuntime("anthropic", "test-key");
		settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		warmer = new CacheWarmer({
			getMode: () => cfgProvidersCacheWarming.get(settings),
			getPromptTokens: () => 100_000,
			stream: () => {
				const message = reply(model, refreshUsage);
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done" as const, reason: "stop" as const, message };
					},
					result: () => Promise.resolve(message),
				};
			},
		});
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sessionModel, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			cacheWarmer: warmer,
			modelRegistry: new ModelRegistry(storage),
			obfuscator: new SecretObfuscator([]),
		});
	}

	/** One main-loop request to `model` whose response wrote the prompt cache. */
	function send(): number {
		const sentAt = Date.now();
		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "short" });
		warmer.onResponse(reply(model, usage({ cacheWrite: 50_000 })));
		return sentAt;
	}

	async function drain(): Promise<void> {
		for (let i = 0; i < 100; i++) await Promise.resolve();
	}

	beforeEach(async () => {
		vi.useFakeTimers();
		tempDir = TempDir.createSync("@pi-prompt-cache-status-");
		model = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), promptCache: { short: 300 } } as Model;
		refreshUsage = usage({ cacheRead: 100_000 });
		await createSession(model);
	});

	afterEach(async () => {
		warmer.cancel();
		vi.useRealTimers();
		authStorage?.close();
		authStorage = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	it("stays warm through the entry's lifetime and turns cold the instant it lapses", () => {
		session.setCacheWarmingMode("off");
		const sentAt = send();

		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS - 1)).toMatchObject({
			state: "warm",
			inferred: false,
			touchedAt: sentAt,
			ttlMs: SHORT_TTL_MS,
		});
		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
			state: "cold",
			reason: { kind: "expired", at: sentAt + SHORT_TTL_MS },
		});
	});

	it("follows a warm refresh that hits past the first lifetime, and turns cold at once when one misses", async () => {
		session.setCacheWarmingMode("idle");
		const sentAt = send();
		vi.advanceTimersByTime(REFRESH_DELAY_MS);
		await drain();
		const refreshedAt = sentAt + REFRESH_DELAY_MS;
		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
			state: "warm",
			touchedAt: refreshedAt,
			warming: { state: "scheduled", nextWarmAt: refreshedAt + REFRESH_DELAY_MS },
		});
		// The persisted refresh carries its send time, which a reopened session counts from.
		expect(session.sessionManager.getEntries().find(entry => entry.type === "model_usage")).toMatchObject({
			purpose: "cache-warm",
			sentAt: refreshedAt,
		});

		refreshUsage = usage({ cacheWrite: 100_000 });
		vi.advanceTimersByTime(REFRESH_DELAY_MS);
		await drain();
		// Still inside the refreshed entry's lifetime: the miss alone makes it cold.
		expect(session.getPromptCacheStatus(Date.now())).toMatchObject({
			state: "cold",
			reason: { kind: "refresh-missed" },
		});
	});

	it("turns cold when the model changed since the last send, naming both models", () => {
		session.setCacheWarmingMode("off");
		const sentAt = send();
		const other = getBundledModel("anthropic", "claude-opus-4-5") as Model;
		session.agent.setModel(other);

		expect(session.getPromptCacheStatus(sentAt + 1)).toMatchObject({
			state: "cold",
			reason: { kind: "model", from: model.name, to: other.name },
		});
	});

	it("turns cold when the thinking level changed since the last send", () => {
		session.setCacheWarmingMode("off");
		session.setThinkingLevel(ThinkingLevel.Low);
		const sentAt = send();
		session.setThinkingLevel(ThinkingLevel.High);

		expect(session.getPromptCacheStatus(sentAt + 1)).toMatchObject({
			state: "cold",
			reason: { kind: "thinking", from: "low", to: "high" },
		});
	});

	it("is hidden for a model that declares no cache lifetime", () => {
		model = { ...model, promptCache: undefined } as Model;
		session.agent.setModel(model);
		session.setCacheWarmingMode("off");
		send();

		expect(session.getPromptCacheStatus(Date.now())).toBeUndefined();
	});

	it("keeps a logged-in Codex cache warm across any gap, so only a change turns it cold", async () => {
		model = getBundledModel("openai-codex", "gpt-5.6-sol") as Model;
		await createSession(model);
		session.setCacheWarmingMode("off");
		const sentAt = send();

		expect(session.getPromptCacheStatus(sentAt + 24 * 3_600_000)).toMatchObject({ state: "warm", ttlMs: undefined });
		session.agent.setModel(getBundledModel("anthropic", "claude-sonnet-4-5") as Model);
		expect(session.getPromptCacheStatus(sentAt + 1)).toMatchObject({ state: "cold", reason: { kind: "model" } });
	});

	it("keeps the size of the request that confirmed the entry when a later request fails", () => {
		session.setCacheWarmingMode("off");
		send();
		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "short" });
		const failed: AssistantMessage = { ...reply(model, usage({})), stopReason: "error" };
		session.agent.appendMessage(failed);
		warmer.onResponse(failed);

		expect(session.getPromptCacheStatus(Date.now())).toMatchObject({ state: "warm", cachedTokens: 50_001 });
	});

	it("never shows another session's entry once this one is armed", async () => {
		session.setCacheWarmingMode("off");
		send();
		await session.sessionManager.newSession();
		expect(session.getPromptCacheStatus(Date.now())).toBeUndefined();

		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "short" });
		warmer.onResponse({ ...reply(model, usage({})), stopReason: "error" });
		expect(session.getPromptCacheStatus(Date.now())).toBeUndefined();
		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "short" });
		warmer.onResponse(reply(model, usage({})));
		expect(session.getPromptCacheStatus(Date.now())).toBeUndefined();
	});

	describe("for a transcript this process has not sent (a reopened session)", () => {
		beforeEach(async () => {
			model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
			await createSession(model);
		});

		it("infers the entry from the newest cached reply's send time and its model's lifetime", () => {
			const ttlMs = model.promptCache!.short! * 1000;
			const sentAt = Date.now();
			session.sessionManager.appendMessage(
				reply(model, usage({ cacheWrite: 50_000, cttl: { ephemeral5m: 50_000 } })),
			);

			expect(session.getPromptCacheStatus(sentAt + ttlMs - 1)).toMatchObject({
				state: "warm",
				inferred: true,
				tier: "short",
				touchedAt: sentAt,
			});
			expect(session.getPromptCacheStatus(sentAt + ttlMs)).toMatchObject({
				state: "cold",
				reason: { kind: "expired", at: sentAt + ttlMs },
			});
		});

		it("reads a compaction after the newest cached reply as cold", () => {
			const replyId = session.sessionManager.appendMessage(reply(model, usage({ cacheRead: 50_000 })));
			session.sessionManager.appendCompaction("summary", undefined, replyId, 50_000);

			expect(session.getPromptCacheStatus(Date.now() + 1)).toMatchObject({
				state: "cold",
				inferred: true,
				reason: { kind: "compaction" },
			});
		});

		it("reads the size of the cached reply it inferred from, not a newer uncached one", () => {
			session.sessionManager.appendMessage(reply(model, usage({ cacheWrite: 50_000 })));
			session.sessionManager.appendMessage(reply(model, usage({})));

			expect(session.getPromptCacheStatus(Date.now() + 1)).toMatchObject({
				state: "warm",
				inferred: true,
				cachedTokens: 50_001,
			});
		});

		it("counts a warm refresh from when it was sent, and a refresh without a send time not at all", () => {
			const sentAt = Date.now();
			session.sessionManager.appendMessage(
				reply(model, usage({ cacheWrite: 50_000, cttl: { ephemeral5m: 50_000 } })),
			);
			const appendRefresh = (refreshSentAt?: number) =>
				session.sessionManager.appendModelUsage(
					{
						purpose: "cache-warm",
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage({ cacheRead: 50_000 }),
						stopReason: "stop",
						...(refreshSentAt === undefined ? {} : { sentAt: refreshSentAt }),
					},
					{ sessionId: session.sessionManager.getSessionId(), parentId: session.sessionManager.getLeafId() },
				);
			// Sent at 90% of the lifetime, recorded once it completed seconds later.
			vi.advanceTimersByTime(REFRESH_DELAY_MS + 5_000);
			appendRefresh(sentAt + REFRESH_DELAY_MS);
			expect(session.getPromptCacheStatus(Date.now())).toMatchObject({ touchedAt: sentAt + REFRESH_DELAY_MS });

			// Past the reply's own lifetime: a refresh with no send time proves nothing.
			vi.advanceTimersByTime(30_000);
			appendRefresh();
			expect(session.getPromptCacheStatus(Date.now())).toMatchObject({
				state: "cold",
				reason: { kind: "expired", at: sentAt + SHORT_TTL_MS },
			});
		});

		it("judges the system prompt by the digest recorded before the cached reply, not a newer one", () => {
			session.sessionManager.appendMessage(reply(model, usage({ cacheRead: 50_000 })));
			// A later, uncached reply ran under another prompt; the cached one's prompt is unrecorded.
			session.sessionManager.appendCustomEntry("system-prompt-digest", "0");
			session.sessionManager.appendMessage(reply(model, usage({})));

			expect(session.getPromptCacheStatus(Date.now() + 1)).toMatchObject({ state: "warm", inferred: true });
		});

		it("folds each branch entry once across repeated reads, then only the appended ones", () => {
			for (let index = 0; index < 1_000; index++) session.sessionManager.appendCustomEntry("unrelated", index);
			const branch = session.sessionManager.getBranchView();
			let reads = 0;
			const counted = new Proxy(branch, {
				get(target, key, receiver) {
					if (typeof key === "string" && /^\d+$/.test(key)) reads++;
					return Reflect.get(target, key, receiver);
				},
			});
			const view = vi.spyOn(session.sessionManager, "getBranchView").mockReturnValue(counted);
			// The next request's size estimate walks the branch on its own account.
			const estimate = vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
			try {
				for (let index = 0; index < 10; index++) expect(session.getPromptCacheStatus(Date.now())).toBeUndefined();
				expect(reads).toBe(1_000);

				reads = 0;
				session.sessionManager.appendMessage(reply(model, usage({ cacheWrite: 50_000 })));
				expect(session.getPromptCacheStatus(Date.now() + 1)).toMatchObject({ state: "warm", inferred: true });
				expect(reads).toBe(1);
			} finally {
				view.mockRestore();
				estimate.mockRestore();
			}
		});

		it("names the lapsed lifetime over a system prompt change once the entry would have expired", () => {
			const ttlMs = model.promptCache!.long! * 1000;
			// The newest reply was produced under a prompt this process no longer builds.
			session.sessionManager.appendCustomEntry("system-prompt-digest", "0");
			const sentAt = Date.now();
			session.sessionManager.appendMessage(
				reply(model, usage({ cacheRead: 50_000, cttl: { ephemeral1h: 50_000 } })),
			);

			expect(session.getPromptCacheStatus(sentAt + ttlMs - 1)).toMatchObject({
				state: "cold",
				reason: { kind: "system-prompt" },
			});
			expect(session.getPromptCacheStatus(sentAt + 3 * ttlMs)).toMatchObject({
				state: "cold",
				reason: { kind: "expired", at: sentAt + ttlMs },
			});
		});
	});
});
