import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, StopReason, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgProvidersCacheRetention, cfgProvidersCacheWarming } from "@oh-my-pi/pi-coding-agent/session/settings";
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

const LOOKUP_TOOL = {
	name: "lookup",
	label: "Lookup",
	description: "Look up a value",
	parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	execute: async () => ({ content: [], details: {} }),
};

describe("AgentSession prompt-cache status", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let settings: Settings;
	let session: AgentSession;
	let warmer: CacheWarmer;
	let model: Model;
	/** What a warm refresh reads back: a hit by default. */
	let refreshUsage: Usage;
	let refreshStopReason: StopReason;
	/** Holds a warm refresh back before the provider sends it (a wait for a provider slot). */
	let refreshGate: Promise<void> | undefined;
	/** Holds a sent warm refresh's response back. */
	let responseGate: Promise<void> | undefined;

	async function createSession(sessionModel: Model): Promise<void> {
		warmer?.cancel();
		authStorage?.close();
		const agentDir = tempDir.path();
		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		warmer = new CacheWarmer({
			getMode: () => cfgProvidersCacheWarming.get(settings),
			getPromptTokens: () => 100_000,
			stream: async (_model, _context, options) => {
				await refreshGate;
				await options?.onPayload?.({});
				await responseGate;
				const message: AssistantMessage = { ...reply(model, refreshUsage), stopReason: refreshStopReason };
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
			modelRegistry: new ModelRegistry(authStorage),
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

	/** Lets a warm refresh the fake timers fired run to its end. */
	async function drain(): Promise<void> {
		for (let i = 0; i < 100; i++) await Promise.resolve();
	}

	beforeEach(async () => {
		vi.useFakeTimers();
		tempDir = TempDir.createSync("@pi-prompt-cache-status-");
		model = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), promptCache: { short: 300 } } as Model;
		refreshUsage = usage({ cacheRead: 100_000 });
		refreshStopReason = "stop";
		refreshGate = undefined;
		responseGate = undefined;
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

	describe("for a request this process sent", () => {
		it("stays warm through the entry's lifetime and turns cold the instant it lapses", () => {
			session.setCacheWarmingMode("off");
			const sentAt = send();

			expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS - 1)).toMatchObject({
				state: "warm",
				inferred: false,
				touchedAt: sentAt,
			});
			expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
				state: "cold",
				reason: { kind: "expired", at: sentAt + SHORT_TTL_MS },
			});
		});

		const user = () => session.agent.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		it.each([
			{
				name: "another model",
				after: () => session.agent.setModel(getBundledModel("anthropic", "claude-opus-4-5") as Model),
				expected: () => ({
					state: "cold",
					reason: { kind: "model", from: model.name, to: getBundledModel("anthropic", "claude-opus-4-5").name },
				}),
			},
			{
				name: "another thinking level",
				before: () => session.setThinkingLevel(ThinkingLevel.Low),
				after: () => session.setThinkingLevel(ThinkingLevel.High),
				expected: () => ({ state: "cold", reason: { kind: "thinking", from: "low", to: "high" } }),
			},
			...[
				{ description: "Look up a value by key" },
				{ strict: true },
				// Examples reach the wire through the rendered description.
				{ examples: [{ caption: "Find a user", call: { query: "user:42" } }] },
			].map(change => ({
				name: `a same-name tool with ${Object.keys(change)[0]} changed`,
				before: () => session.agent.setTools([LOOKUP_TOOL]),
				after: () => session.agent.setTools([{ ...LOOKUP_TOOL, ...change }]),
				expected: () => ({ state: "cold", reason: { kind: "tools" } }),
			})),
			{
				name: "another cache retention setting",
				after: () => cfgProvidersCacheRetention.override(settings, "long"),
				expected: () => ({ state: "cold", reason: { kind: "retention" } }),
			},
			{
				name: "a compaction, read off the branch",
				before: user,
				after: () => {
					const replyId = session.sessionManager.appendMessage(reply(model, usage({ cacheWrite: 50_000 })));
					session.sessionManager.appendCompaction("summary", undefined, replyId, 50_000);
					session.agent.replaceMessages([]);
				},
				expected: () => ({ state: "cold", reason: { kind: "compaction" } }),
			},
			{
				// Switching away and back rebuilds the same transcript from new message objects.
				name: "the same transcript rebuilt, read off the branch",
				before: user,
				after: () => {
					session.sessionManager.appendMessage(reply(model, usage({ cacheWrite: 50_000 })));
					session.agent.replaceMessages(session.messages.map(message => ({ ...message })));
				},
				expected: () => ({ state: "warm", inferred: true }),
			},
		])("after $name", ({ before, after, expected }) => {
			session.setCacheWarmingMode("off");
			before?.();
			const sentAt = send();
			after();

			expect(session.getPromptCacheStatus(sentAt + 1)).toMatchObject(expected());
		});

		it("follows a refresh that hits past the first lifetime, and turns cold when one misses", async () => {
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
			// The persisted outcome is what a reopened session counts from.
			expect(session.sessionManager.getEntries().find(entry => entry.type === "model_usage")).toMatchObject({
				cacheRefresh: { sentAt: refreshedAt, hit: true },
			});

			refreshUsage = usage({});
			vi.advanceTimersByTime(REFRESH_DELAY_MS);
			await drain();
			expect(session.getPromptCacheStatus(Date.now())).toMatchObject({
				state: "cold",
				reason: { kind: "refresh-missed" },
			});
		});

		it("keeps the entry warm from a refresh that wrote the prefix again, and stops refreshing", async () => {
			session.setCacheWarmingMode("idle");
			const sentAt = send();
			refreshUsage = usage({ cacheRead: 20_000, cacheWrite: 80_000 });
			vi.advanceTimersByTime(REFRESH_DELAY_MS);
			await drain();

			expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
				state: "warm",
				touchedAt: sentAt + REFRESH_DELAY_MS,
				warming: { state: "inactive", reason: "refresh missed the cache" },
			});
		});

		it("records no refresh outcome for a failed refresh or one the conversation moved on from", async () => {
			session.setCacheWarmingMode("idle");
			const refreshes = () =>
				session.sessionManager.getEntries().flatMap(entry => (entry.type === "model_usage" ? [entry] : []));
			session.agent.appendMessage({ role: "user", content: "question", timestamp: Date.now() });

			// A paid error that still read part of the cache.
			send();
			refreshStopReason = "error";
			vi.advanceTimersByTime(REFRESH_DELAY_MS);
			await drain();

			// A hit that lands after the transcript was replaced.
			send();
			refreshStopReason = "stop";
			const slot = Promise.withResolvers<void>();
			refreshGate = slot.promise;
			vi.advanceTimersByTime(REFRESH_DELAY_MS);
			await drain();
			session.agent.replaceMessages(session.messages.map(message => ({ ...message })));
			slot.resolve();
			await drain();

			expect(refreshes().map(entry => entry.cacheRefresh)).toEqual([undefined, undefined]);
		});

		it("counts the lifetime and the next refresh from when the provider sent the request, past a slot wait", () => {
			session.setCacheWarmingMode("idle");
			const context = { messages: [] };
			session.startCacheWarming(model, context, { cacheRetention: "short" });
			vi.advanceTimersByTime(30_000);
			const sentAt = Date.now();
			session.markPromptCacheDispatched(context);
			warmer.onResponse(reply(model, usage({ cacheWrite: 50_000 })));

			expect(session.getPromptCacheStatus(sentAt)).toMatchObject({
				state: "warm",
				touchedAt: sentAt,
				warming: { state: "scheduled", nextWarmAt: sentAt + REFRESH_DELAY_MS },
			});
		});

		it("holds expiry off only for a refresh the provider sent before the entry lapsed", async () => {
			session.setCacheWarmingMode("idle");
			const response = Promise.withResolvers<void>();
			responseGate = response.promise;
			let sentAt = send();
			vi.advanceTimersByTime(REFRESH_DELAY_MS);
			await drain();
			expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS + 1_000)).toMatchObject({
				state: "warm",
				warming: { state: "refreshing" },
			});
			response.resolve();
			await drain();

			// Queued for a provider slot, the refresh holds nothing off; sent after the lapse, it revives nothing.
			const slot = Promise.withResolvers<void>();
			refreshGate = slot.promise;
			const late = Promise.withResolvers<void>();
			responseGate = late.promise;
			sentAt = send();
			vi.advanceTimersByTime(REFRESH_DELAY_MS);
			await drain();
			const expired = { state: "cold", reason: { kind: "expired", at: sentAt + SHORT_TTL_MS } };
			expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
				...expired,
				warming: { state: "scheduled" },
			});
			vi.advanceTimersByTime(SHORT_TTL_MS - REFRESH_DELAY_MS + 1_000);
			slot.resolve();
			await drain();
			expect(session.getPromptCacheStatus(Date.now())).toMatchObject({
				...expired,
				warming: { state: "refreshing" },
			});
			late.resolve();
			await drain();
		});

		it("keeps a logged-in Codex entry warm across any gap", async () => {
			model = getBundledModel("openai-codex", "gpt-5.6-sol") as Model;
			await createSession(model);
			session.setCacheWarmingMode("off");
			const sentAt = send();

			expect(session.getPromptCacheStatus(sentAt + 24 * 3_600_000)).toMatchObject({
				state: "warm",
				ttlMs: undefined,
			});
		});

		it("shows nothing for a model without a cache lifetime, another session's entry, or after /clear", async () => {
			session.setCacheWarmingMode("off");
			session.agent.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
			const sentAt = send();
			session.sessionManager.appendMessage(reply(model, usage({ cacheWrite: 50_000 })));
			expect(await session.resetSessionContext()).toBeDefined();
			expect(session.getPromptCacheStatus(sentAt + 1)).toBeUndefined();

			send();
			await session.sessionManager.newSession();
			expect(session.getPromptCacheStatus(Date.now())).toBeUndefined();

			model = { ...model, promptCache: undefined } as Model;
			session.agent.setModel(model);
			send();
			expect(session.getPromptCacheStatus(Date.now())).toBeUndefined();
		});
	});

	describe("for a transcript this process has not sent (a reopened session)", () => {
		const append = (replyUsage: Usage) => session.sessionManager.appendMessage(reply(model, replyUsage));

		// The bundled model declares both tiers.
		beforeEach(async () => {
			model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
			await createSession(model);
		});

		it("is read off the newest cached reply's send time and its model's lifetime", () => {
			const sentAt = Date.now();
			append(usage({ cacheWrite: 50_000, cttl: { ephemeral5m: 50_000 } }));
			// A newer reply that used no cache does not replace it.
			append(usage({}));

			expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS - 1)).toMatchObject({
				state: "warm",
				inferred: true,
				tier: "short",
				touchedAt: sentAt,
				cachedTokens: 50_001,
			});
			expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
				state: "cold",
				reason: { kind: "expired", at: sentAt + SHORT_TTL_MS },
			});
		});

		it.each([
			{
				name: "a compaction after the cached reply",
				setup: () => {
					const replyId = append(usage({ cacheRead: 50_000 }));
					session.sessionManager.appendCompaction("summary", undefined, replyId, 50_000);
				},
				expected: { state: "cold", reason: { kind: "compaction" } },
			},
			{
				name: "a retention setting that no longer asks for the tier written",
				setup: () => {
					append(usage({ cacheWrite: 50_000, cttl: { ephemeral1h: 50_000 } }));
					cfgProvidersCacheRetention.override(settings, "none");
				},
				expected: { state: "cold", tier: "long", reason: { kind: "retention" } },
			},
			{
				// The served model is retagged on the reply; the entry is the requested one's.
				name: "a server-side fallback reply",
				setup: () =>
					session.sessionManager.appendMessage({
						...reply(model, usage({ cacheWrite: 50_000 })),
						model: "claude-unlisted-fallback",
						content: [
							{ type: "fallback", from: { model: model.id }, to: { model: "claude-unlisted-fallback" } },
							{ type: "text", text: "done" },
						],
					}),
				expected: { state: "warm", inferred: true },
			},
			{
				// Only the digest recorded before the cached reply judges its system prompt.
				name: "a prompt digest recorded after the cached reply",
				setup: () => {
					append(usage({ cacheRead: 50_000 }));
					session.sessionManager.appendCustomEntry("system-prompt-digest", "0");
				},
				expected: { state: "warm", inferred: true },
			},
			{
				name: "a prompt digest recorded before the cached reply that no longer matches",
				setup: () => {
					session.sessionManager.appendCustomEntry("system-prompt-digest", "0");
					append(usage({ cacheRead: 50_000 }));
				},
				expected: { state: "cold", reason: { kind: "system-prompt" } },
			},
		])("reads $name", ({ setup, expected }) => {
			setup();
			expect(session.getPromptCacheStatus(Date.now() + 1)).toMatchObject(expected);
		});

		it("follows persisted refresh outcomes, ignoring one recorded without an outcome", () => {
			const sentAt = Date.now();
			append(usage({ cacheWrite: 50_000, cttl: { ephemeral5m: 50_000 } }));
			const refresh = (refreshUsage: Usage, cacheRefresh?: { sentAt: number; hit: boolean }) =>
				session.sessionManager.appendModelUsage(
					{
						purpose: "cache-warm",
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: refreshUsage,
						stopReason: "stop",
						...(cacheRefresh ? { cacheRefresh } : {}),
					},
					{ sessionId: session.sessionManager.getSessionId(), parentId: session.sessionManager.getLeafId() },
				);
			// Sent at 90% of the lifetime, recorded once it completed seconds later.
			vi.advanceTimersByTime(REFRESH_DELAY_MS + 5_000);
			const refreshedAt = sentAt + REFRESH_DELAY_MS;
			refresh(usage({ cacheRead: 50_000 }), { sentAt: refreshedAt, hit: true });
			refresh(usage({ cacheWrite: 50_000 }));
			expect(session.getPromptCacheStatus(Date.now())).toMatchObject({ state: "warm", touchedAt: refreshedAt });

			// A refresh that wrote the prefix again left it cached from its send.
			const rewrittenAt = Date.now();
			refresh(usage({ cacheWrite: 50_000 }), { sentAt: rewrittenAt, hit: false });
			expect(session.getPromptCacheStatus(Date.now())).toMatchObject({ state: "warm", touchedAt: rewrittenAt });

			refresh(usage({}), { sentAt: Date.now(), hit: false });
			expect(session.getPromptCacheStatus(Date.now())).toMatchObject({
				state: "cold",
				reason: { kind: "refresh-missed" },
			});
		});

		it("names the lapsed lifetime over a system prompt change once the entry would have expired", () => {
			session.sessionManager.appendCustomEntry("system-prompt-digest", "0");
			const sentAt = Date.now();
			append(usage({ cacheRead: 50_000, cttl: { ephemeral5m: 50_000 } }));

			expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
				state: "cold",
				reason: { kind: "expired", at: sentAt + SHORT_TTL_MS },
			});
		});
	});
});
