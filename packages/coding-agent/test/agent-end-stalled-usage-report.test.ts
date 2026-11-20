/**
 * Contract: usage-limit bookkeeping on the agent_end path is best effort. A
 * usage report that never settles must not hold the run's terminal `agent_end`
 * frame — the bound degrades to "no report" and the retry-after hint decides
 * the wait. Regression for issue #19411: an over-quota 429 with a multi-hour
 * reset left RPC hosts waiting forever because `markReached` was unbounded.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { opencodeGoUsageProvider } from "@oh-my-pi/pi-ai/usage/opencode-go";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Mirrors USAGE_LIMIT_BOOKKEEPING_TIMEOUT_MS in turn-recovery.ts. */
const BOOKKEEPING_TIMEOUT_MS = 3_000;

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected trailing assistant message");
	return message as AssistantMessage;
}

describe("agent_end with a stalled usage report", () => {
	let session: AgentSession | undefined;
	let storage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		storage?.close();
		storage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
		vi.restoreAllMocks();
	});

	it("emits agent_end when the usage report never settles (bookkeeping must be bounded)", async () => {
		// Drive the bound deterministically: the bookkeeping signal comes from a
		// controller we own, so the test never waits on the real 3s timer. The
		// usage endpoint never answers, so only that bound can free agent_end.
		const bookkeeping = new AbortController();
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms =>
			ms === BOOKKEEPING_TIMEOUT_MS ? bookkeeping.signal : realTimeout(ms),
		);
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);

		tempDir = TempDir.createSync("@pi-stalled-usage-");
		const localStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		const reportStarted = Promise.withResolvers<void>();
		storage = new AuthStorage(localStore, {
			usageProviderResolver: provider => (provider === "opencode-go" ? opencodeGoUsageProvider : undefined),
			usageFetch: (() => {
				reportStarted.resolve();
				return new Promise<Response>(() => {});
			}) as unknown as typeof fetch,
		});
		await storage.credentials.reload();
		await storage.credentials.set("opencode-go", { type: "api_key", key: "opencode-go-stalled-key" });

		const model = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!model) throw new Error("Expected bundled OpenCode Go test model to exist");

		const registry = new ModelRegistry(storage, path.join(tempDir.path(), "models.yml"));
		const mock = createMockModel({ responses: [{ throw: "429 quota exceeded. retry-after-ms=11180000" }] });
		const agent = new Agent({
			getApiKey: () => "opencode-go-runtime-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});

		const agentEnds: Extract<AgentSessionEvent, { type: "agent_end" }>[] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") agentEnds.push(event);
		});

		const promptPromise = session.prompt("Trigger usage limit with a stalled usage report");
		await reportStarted.promise;
		bookkeeping.abort();
		await promptPromise;
		await session.waitForIdle();

		expect(agentEnds).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	}, 10_000);
});
