import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { normalizeOpenAIPromptCacheKey } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { getTestModel } from "./helpers/model-fixtures";
import { assistantMsg, userMsg } from "./utilities";

/**
 * Regression for PR16988 review thread PRRT_kwDOQxs0bc6wFtDX:
 * session-maintenance compaction must not pass a sessionId fallback as the
 * compaction `promptCacheKey`. V2's header builder treats a truthy
 * `promptCacheKey` as an EXPLICIT cache identity and flips the Go gateway's
 * `x-opencode-session` affinity to the normalized (`pc_`-hash) cache id, even
 * though only the session id is known. Without an explicit key the raw child
 * conversation id must stay on the header while the body `prompt_cache_key`
 * keeps its 64-char-normalized value — both coding compaction paths
 * (manual `#compactWithFallbackModel` and auto `runAutoCompaction`) are
 * separate callsites, so both are exercised through the real session.
 *
 * Explicit-key / empty-key / retention behavior stays covered by the existing
 * direct-helper suites (packages/agent/test/remote-compaction.test.ts,
 * packages/ai/test/opencode-session-header.test.ts); this file adds only the
 * caller-level provenance checks — including the mirror case of thread
 * PRRT_kwDOQxs0bc6wG-Mm, where a Task child's family key exists only in the
 * session header and MUST still reach the compaction request.
 */

const OPENCODE_SESSION_HEADER = "x-opencode-session";
/** Raw SDK session id over the 64-char cache-key wire limit (normalizes to pc_…). */
const RAW_SESSION_ID = `ses_${"0123456789abcdef".repeat(6)}`;
/** Task-family affinity key persisted in the session header; also over the 64-char wire limit. */
const FAMILY_CACHE_KEY = `ses_${"fedcba9876543210".repeat(4)}`;

interface CapturedCompactionRequest {
	url: string;
	sessionHeader: string | null;
	body: { prompt_cache_key?: string; input: Array<Record<string, unknown>> };
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("session-maintenance V2 compaction cache-key provenance", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let goModel: Model;
	let compactionRequests: CapturedCompactionRequest[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-provenance-");
		// Eligible Go model: opted for task-sibling prompt-cache affinity on the
		// openai-responses lane (opencode-go.kdl), with V2 streaming compaction.
		goModel = {
			...getTestModel(
				"opencode-go",
				model => model.api === "openai-responses" && model.id === "muse-spark-1.2-contributor",
			),
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		};
		const settings = Settings.isolated({
			"compaction.autoContinue": false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["remote"],
			"contextPromotion.enabled": false,
		});
		const agent = new Agent({
			initialState: { model: goModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(goModel.provider, "go-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			// Long raw SDK provider session id; no providerPromptCacheKey in the
			// session header, so agent.promptCacheKey stays undefined.
			providerSessionId: RAW_SESSION_ID,
		});
		session.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([goModel]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		compactionRequests = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				const body = JSON.parse(String(init?.body ?? "{}")) as CapturedCompactionRequest["body"];
				if (body.input?.at(-1)?.type === "compaction_trigger") {
					compactionRequests.push({
						url,
						sessionHeader: new Headers(init?.headers).get(OPENCODE_SESSION_HEADER),
						body,
					});
					return sseResponse([
						{
							type: "response.output_item.done",
							output_index: 0,
							item: { type: "compaction", encrypted_content: "enc" },
						},
						{
							type: "response.completed",
							response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
						},
					]);
				}
				throw new Error(`Unexpected request during compaction provenance test: ${url}`);
			}),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	/**
	 * The one compaction request that went over the wire must carry:
	 * - body `prompt_cache_key` = the normalized wire cache id (`pc_…` hash of
	 *   the long session id) — unchanged by this fix;
	 * - `x-opencode-session` = the RAW child conversation id, never the derived
	 *   hash (the session-id-derived cache id must not feed family affinity).
	 */
	function expectRawChildHeaderNormalizedBodyKey(): void {
		expect(session.agent.promptCacheKey).toBeUndefined();
		expect(compactionRequests).toHaveLength(1);
		const request = compactionRequests[0];
		if (!request) throw new Error("Expected a V2 compaction request");
		const normalized = normalizeOpenAIPromptCacheKey(RAW_SESSION_ID);
		if (!normalized?.startsWith("pc_")) throw new Error("Expected the long session id to normalize to pc_…");
		expect(normalized).not.toBe(RAW_SESSION_ID);
		expect(request.body.prompt_cache_key).toBe(normalized);
		expect(request.sessionHeader).toBe(RAW_SESSION_ID);
		expect(request.sessionHeader).not.toBe(request.body.prompt_cache_key);
		expect(request.url.endsWith("/responses")).toBe(true);
	}

	it("keeps the raw child session id on manual compaction V2 requests without an explicit cache key", async () => {
		const result = await session.compact();
		await session.waitForIdle();
		expect(result?.shortSummary).toBe("Remote compaction");
		expectRawChildHeaderNormalizedBodyKey();
	});

	/** Drive a threshold-crossing assistant turn so `runAutoCompaction` issues its V2 request. */
	async function triggerAutoCompaction(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") resolve();
		});
		const contextWindow = goModel.contextWindow;
		if (!contextWindow) throw new Error("Expected current model context window");
		const assistant = {
			...assistantMsg("threshold reached"),
			api: goModel.api,
			provider: goModel.provider,
			model: goModel.id,
			usage: {
				input: contextWindow,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: contextWindow + 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		await promise;
		await session.waitForIdle();
	}

	it("keeps the raw child session id on auto-compaction V2 requests without an explicit cache key", async () => {
		await triggerAutoCompaction();
		expectRawChildHeaderNormalizedBodyKey();
	});

	/**
	 * PR16988 review thread PRRT_kwDOQxs0bc6wG-Mm: a Task child keeps its
	 * affinity ONLY in the session header — `createAgentSession` persists
	 * `taskPromptCacheKey` while leaving `agent.promptCacheKey` undefined — so a
	 * compaction that reads the agent field alone sends no family key, and the Go
	 * gateway warms its cache under the CHILD conversation id instead of the
	 * family the child's normal turns share. Returns the normalized family cache
	 * id both wire fields must carry.
	 */
	async function seedTaskFamilyAffinity(): Promise<string> {
		// The same header write createAgentSession performs for a Task child.
		await session.sessionManager.setTaskPromptCacheKey(FAMILY_CACHE_KEY);
		expect(session.sessionManager.getHeader()?.taskPromptCacheKey).toBe(FAMILY_CACHE_KEY);
		expect(session.agent.promptCacheKey).toBeUndefined();
		const normalized = normalizeOpenAIPromptCacheKey(FAMILY_CACHE_KEY);
		if (normalized === undefined || !normalized.startsWith("pc_")) {
			throw new Error("Expected the family key to normalize to pc_…");
		}
		expect(normalized).not.toBe(RAW_SESSION_ID);
		return normalized;
	}

	function expectFamilyKeyOnWire(familyKey: string): void {
		expect(session.agent.promptCacheKey).toBeUndefined();
		expect(compactionRequests).toHaveLength(1);
		const request = compactionRequests[0];
		if (!request) throw new Error("Expected a V2 compaction request");
		// The gateway affinity header and the body cache key must both carry the
		// family identity — never the child conversation id.
		expect(request.sessionHeader).toBe(familyKey);
		expect(request.body.prompt_cache_key).toBe(familyKey);
		expect(request.url.endsWith("/responses")).toBe(true);
	}

	it("passes the session-header Task family cache key into manual compaction", async () => {
		const familyKey = await seedTaskFamilyAffinity();
		const result = await session.compact();
		await session.waitForIdle();
		expect(result?.shortSummary).toBe("Remote compaction");
		expectFamilyKeyOnWire(familyKey);
	});

	it("passes the session-header Task family cache key into auto compaction", async () => {
		const familyKey = await seedTaskFamilyAffinity();
		await triggerAutoCompaction();
		expectFamilyKeyOnWire(familyKey);
	});

	it("gates the remote compaction key on the override target, not the unopted active model", async () => {
		// Active lane grok-4.7 does not opt into shared prompt caching, but
		// remote compaction sends the opted Contributor id: the family key must
		// reach that request even though the live turn would not use it.
		Object.assign(goModel, {
			id: "grok-4.7",
			remoteCompaction: { enabled: true, v2StreamingEnabled: true, model: "muse-spark-1.2-contributor" },
		});
		const familyKey = await seedTaskFamilyAffinity();
		expect(session.getPromptCacheKeyForModel(goModel)).toBeUndefined();
		const result = await session.compact();
		await session.waitForIdle();
		expect(result?.shortSummary).toBe("Remote compaction");
		expectFamilyKeyOnWire(familyKey);
	});
});
