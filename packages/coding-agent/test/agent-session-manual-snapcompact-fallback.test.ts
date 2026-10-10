import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function summaryResponse(model: Model, stopReason: "stop" | "error" = "stop"): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Condensed conversation" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 80,
				output: 20,
				cacheRead: 30,
				cacheWrite: 0,
				totalTokens: 130,
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
			},
			timestamp: Date.now(),
		};
		if (stopReason === "error") {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					...message,
					content: [],
					stopReason: "error",
					errorStatus: 529,
					errorMessage: "overloaded_error: Overloaded",
				},
			});
		} else {
			stream.push({ type: "done", reason: "stop", message });
		}
	});
	return stream;
}

/**
 * Regression for issue #5064.
 *
 * Manual `/compact` with the default snapcompact strategy hard-threw
 * ("snapcompact cannot run locally: <id> is text-only") when the active model
 * lacked image input, even though the auto-compaction path already downgraded
 * to LLM-backed compaction in the same situation. The manual path MUST mirror
 * that behavior: warn, then summarize via the LLM fallback candidate chain
 * (which tries the active text→text model first).
 *
 * An *explicit* `/compact snapcompact` (mode override) is a deliberate no-LLM
 * archive request, so it MUST keep failing locally instead of silently
 * shipping the transcript to a provider.
 */
describe("AgentSession manual snapcompact text-only fallback", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
			session = undefined;
			authStorage = undefined;
			tempDir = undefined;
		}
	});

	async function createHarness(sideStreamFn?: StreamFn): Promise<{
		session: AgentSession;
		sessionManager: SessionManager;
		activeModel: Model;
		notices: string[];
	}> {
		const activeModel = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
		if (!activeModel) throw new Error("Expected bundled text-only model");
		expect(activeModel.input).not.toContain("image");

		tempDir = TempDir.createSync("@pi-manual-snapcompact-text-only-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("aimlapi", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const agent = new Agent({
			initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const seed: Message[] = [
			{ role: "user", content: "first question", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: activeModel.api,
				provider: activeModel.provider,
				model: activeModel.id,
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
			},
			{ role: "user", content: "second question", timestamp: Date.now() },
		];
		for (const message of seed) sessionManager.appendMessage(message);
		if (!sessionManager.getBranch()[0]?.id) throw new Error("Expected seeded branch entry");

		const settings = Settings.isolated({
			"compaction.methodOrder": ["snapcompact", "soft"],
			"compaction.experimentalContextManagement": false,
			"compaction.keepRecentTokens": 1,
		});
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, sideStreamFn });
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
		});

		return { session, sessionManager, activeModel, notices };
	}

	it("falls back to LLM compaction instead of throwing on a text-only active model", async () => {
		const harness = await createHarness();

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "llm summary",
			shortSummary: "llm",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: { provider: model.provider, model: model.id },
		}));

		const result = await harness.session.compact();

		expect(result.summary).toBe("llm summary");
		// The preference resolver skips snapcompact and tries the active model for soft compaction.
		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(`${firstCandidate.provider}/${firstCandidate.id}`).toBe(
			`${harness.activeModel.provider}/${harness.activeModel.id}`,
		);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "llm summary",
		});
	});

	it("journals every soft summary request and includes its cost in active session totals", async () => {
		const sideStreamFn: StreamFn = model => summaryResponse(model);
		const { session, sessionManager } = await createHarness(sideStreamFn);
		await session.compact(undefined, { mode: "soft" });

		const ledger = sessionManager.getBranch().filter(entry => entry.type === "model_usage");
		expect(ledger.map(entry => entry.purpose)).toEqual(["compaction:summary", "compaction:short-summary"]);
		expect(ledger.map(entry => entry.usage.cacheRead)).toEqual([30, 30]);
		const stats = session.getSessionStats();
		expect(stats.tokens.cacheRead).toBe(60);
		expect(stats.cost).toBe(12);
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const persisted = (await Bun.file(file).text())
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
		expect(persisted.filter(entry => entry.type === "model_usage").map(entry => entry.usage.cacheRead)).toEqual([
			30, 30,
		]);
	});

	it("keeps billed failed attempts when a manual summary retries", async () => {
		let requests = 0;
		const { session, sessionManager } = await createHarness(model =>
			summaryResponse(model, ++requests === 1 ? "error" : "stop"),
		);
		await session.compact(undefined, { mode: "soft" });

		const usage = sessionManager.getBranch().filter(entry => entry.type === "model_usage");
		expect(usage.map(entry => entry.stopReason)).toEqual(["error", "stop", "stop"]);
		expect(usage.map(entry => entry.usage.cacheRead)).toEqual([30, 30, 30]);
		expect(session.getSessionStats().cost).toBe(18);
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const entries = (await Bun.file(file).text())
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
		expect(entries.filter(entry => entry.type === "model_usage").map(entry => entry.stopReason)).toEqual([
			"error",
			"stop",
			"stop",
		]);
	});

	it("keeps billed summary usage when the short-summary request fails", async () => {
		let requests = 0;
		const sideStreamFn: StreamFn = model => {
			if (++requests === 1) return summaryResponse(model);
			throw new Error("Short summary request failed");
		};
		const { session, sessionManager } = await createHarness(sideStreamFn);

		await expect(session.compact(undefined, { mode: "soft" })).rejects.toThrow("Short summary request failed");
		expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
		expect(sessionManager.getBranch().filter(entry => entry.type === "model_usage")).toMatchObject([
			{ purpose: "compaction:summary", usage: { input: 80, output: 20, cacheRead: 30, cost: { total: 6 } } },
		]);
	});

	it("still fails locally for explicit /compact snapcompact on a text-only model (no-LLM contract)", async () => {
		const harness = await createHarness();

		const compactSpy = vi.spyOn(compactionModule, "compact");

		await expect(harness.session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow(
			`snapcompact cannot run locally: ${harness.activeModel.id} is text-only.`,
		);

		// Explicit no-LLM request must never reach the provider-backed summarizer.
		expect(compactSpy).not.toHaveBeenCalled();
		expect(harness.notices).toContain(
			`snapcompact needs a vision-capable model (${harness.activeModel.id} is text-only)`,
		);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toBeUndefined();
	});
});
