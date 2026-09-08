import { afterEach, expect, test, vi } from "bun:test";
import type { ProviderSessionState } from "@oh-my-pi/pi-ai";
import { createOpenAICodexCompatibilityMetadata } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { CodexHistoryNotesBackend } from "@oh-my-pi/pi-ai/providers/openai-codex/history-notes";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../src/config/settings";
import { CodexContextWindowRuntime } from "../src/session/codex-context-window-runtime";
import { SessionManager } from "../src/session/session-manager";

afterEach(() => vi.restoreAllMocks());

test("notes-only runtime enables native history ingestion and removes it when authentication is unavailable", async () => {
	const model = getBundledModel("openai-codex", "gpt-6-astra");
	if (!model) throw new Error("Missing Codex fixture");
	const manager = SessionManager.inMemory();
	const providerSessionState = new Map<string, ProviderSessionState>();
	let authenticated = true;
	vi.spyOn(CodexHistoryNotesBackend.prototype, "threadHint").mockResolvedValue(undefined);
	const runtime = new CodexContextWindowRuntime({
		settings: Settings.isolated({
			"providers.openai-codex.historyNotes": "on",
			"compaction.methodOrder": ["remote"],
		}),
		sessionManager: manager,
		providerSessionState,
		providerSessionId: () => manager.getSessionId(),
		model: () => model,
		agentIdentity: { kind: "sub", id: "WorkerOne" },
		resolveAuth: async () => ({
			provider: model.provider,
			accessToken: "fixture",
			accountId: authenticated ? "account" : undefined,
			baseUrl: model.baseUrl,
		}),
	});
	const requestMetadata = () =>
		JSON.parse(
			createOpenAICodexCompatibilityMetadata({
				sessionId: manager.getSessionId(),
				providerSessionState,
				requestKind: "turn",
			}).clientMetadata["x-codex-turn-metadata"],
		);
	try {
		await runtime.refresh();
		const first = requestMetadata();
		expect(first).toMatchObject({ history_ingest_requested: true, window_number: 1 });
		expect(first.agent_name).toMatch(/^\/root\/workerone_[0-9a-f]{12}$/);
		expect(runtime.windowActive).toBe(false);
		providerSessionState.clear();
		runtime.transform({ messages: [] });
		expect(requestMetadata()).toMatchObject({
			history_ingest_requested: true,
			context_window_id: first.context_window_id,
		});
		authenticated = false;
		await runtime.refresh();
		expect(requestMetadata()).not.toHaveProperty("history_ingest_requested");
	} finally {
		manager.close();
	}
});
