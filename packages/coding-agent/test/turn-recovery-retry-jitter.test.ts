import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { AUTOMATIC_RETRY_JITTER_WINDOW_MS, automaticRetryJitterMs } from "../src/session/turn-recovery";
import { SessionManager } from "../src/session/session-manager";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

describe("automaticRetryJitterMs", () => {
	it("is deterministic for the same session id", () => {
		const id = "pi:01a20077-be4f-701f-9a95-7ed6cd4f7051";
		expect(automaticRetryJitterMs(id, AUTOMATIC_RETRY_JITTER_WINDOW_MS)).toBe(
			automaticRetryJitterMs(id, AUTOMATIC_RETRY_JITTER_WINDOW_MS),
		);
	});

	it("stays within [0, windowMs)", () => {
		for (let i = 0; i < 500; i++) {
			const offset = automaticRetryJitterMs(`session-${i}`, AUTOMATIC_RETRY_JITTER_WINDOW_MS);
			expect(offset).toBeGreaterThanOrEqual(0);
			expect(offset).toBeLessThan(AUTOMATIC_RETRY_JITTER_WINDOW_MS);
		}
	});

	it("spreads distinct session ids across the window", () => {
		const offsets = new Set<number>();
		for (let i = 0; i < 200; i++) {
			offsets.add(
				automaticRetryJitterMs(
					`pi:00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
					AUTOMATIC_RETRY_JITTER_WINDOW_MS,
				),
			);
		}
		// A lockstep resume storm needs distinct offsets: 200 ids must land on
		// many different offsets, never collapse to one or a few.
		expect(offsets.size).toBeGreaterThan(100);
	});

	it("maps an empty id to zero without throwing", () => {
		expect(automaticRetryJitterMs("", AUTOMATIC_RETRY_JITTER_WINDOW_MS)).toBe(0);
	});

	it("returns zero for a zero window (the exact-clock test seam)", () => {
		expect(automaticRetryJitterMs("any-session", 0)).toBe(0);
		expect(automaticRetryJitterMs("any-session", -1)).toBe(0);
	});

	it("scales offsets into a smaller window", () => {
		for (let i = 0; i < 200; i++) {
			expect(automaticRetryJitterMs(`session-${i}`, 100)).toBeLessThan(100);
		}
	});
});

interface AssistantEntry {
	message: AssistantMessage;
}

function assistantEntries(sessionManager: SessionManager): AssistantEntry[] {
	const result: AssistantEntry[] = [];
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		// The union does not discriminate on role; an assistant entry is the
		// AssistantMessage shape (the retry-recovery suite reads the same field).
		const message = entry.message as AssistantMessage;
		if (message.role !== "assistant") continue;
		result.push({ message });
	}
	return result;
}

describe("automatic-retry resume spread (session level)", () => {
	it("resumes the default path with the jitter sleeping inside the retry saga, bounded by retry.maxDelayMs", async () => {
		const tempDir = TempDir.createSync("@pi-retry-jitter-");
		const fixtureDir = TempDir.createSync("@pi-retry-jitter-fixture-");
		const authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
		try {
			vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			authStorage.keys.setRuntime(model.provider, `${model.provider}-test-key`);
			let attempts = 0;
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (requestedModel, context, options) => {
					attempts++;
					if (attempts === 1) {
						mock.push({ throw: "429 rate limited. retry-after-ms=60000" });
					} else {
						mock.push({ content: ["recovered after the spread"], stopReason: "stop" });
					}
					return mock.stream(requestedModel, context, options);
				},
			});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 120000,
				"retry.maxRetries": 1,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
			const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
			const waitSpy = mockSchedulerWaitWithClock();
			const sessionId = sessionManager.getSessionId();

			await session.prompt("Trigger the rate limit once");
			await session.waitForIdle();

			expect(attempts).toBe(2);
			const waits = waitSpy.mock.calls.map(call => call[0] as number);
			// The backoff (~60000 from the hint) fired, the spread slept inside the
			// saga at the session's deterministic offset (window min(5000, 10%)),
			// and no wait exceeded the configured retry ceiling.
			const backoff = waits.find(w => w > 5000);
			expect(backoff).toBeGreaterThan(59000);
			const expectedJitter = automaticRetryJitterMs(sessionId, AUTOMATIC_RETRY_JITTER_WINDOW_MS);
			if (expectedJitter > 0) {
				expect(waits.some(w => Math.abs(w - expectedJitter) < 1)).toBe(true);
			}
			for (const w of waits) expect(w).toBeLessThanOrEqual(120000);
			const last = assistantEntries(sessionManager).at(-1);
			expect(last?.message.content.some(b => b.type === "text" && b.text === "recovered after the spread")).toBe(
				true,
			);
			await session.dispose();
			sessionManager.close();
		} finally {
			tempDir.removeSync();
			fixtureDir.removeSync();
		}
	}, 30000);
});
