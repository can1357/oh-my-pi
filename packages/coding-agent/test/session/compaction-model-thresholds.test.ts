import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { compactionSettingsForModel } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	computeSessionContextBreakdown,
	getSessionCompactionBoundaries,
} from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

type WindowedModel = Model & { contextWindow: number };

function withWindow(model: Model | undefined, contextWindow: number): WindowedModel {
	if (!model) throw new Error("Expected bundled test model to exist");
	// Pin windows so catalog regeneration cannot shift the expected thresholds.
	return { ...model, contextWindow };
}

const claude = withWindow(getBundledModel("anthropic", "claude-sonnet-4-5"), 1_000_000);
const gpt = withWindow(getBundledModel("openai", "gpt-5"), 400_000);
const unmatched = withWindow(getBundledModel("google", "gemini-2.5-flash"), 200_000);

function thresholdFor(settings: Settings, model: WindowedModel): number {
	return resolveThresholdTokens(model.contextWindow, compactionSettingsForModel(settings, model));
}

describe("compaction.modelThresholds", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	it("replaces the global trigger as a unit for the matching model and falls back to globals otherwise", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 150_000,
			"compaction.modelThresholds": { "anthropic/claude-sonnet-*": "60%", "openai/gpt-5": 300_000 },
		});

		// The global thresholdTokens would win over a percentage; the model entry replaces both fields.
		expect(thresholdFor(settings, claude)).toBe(600_000);
		expect(thresholdFor(settings, gpt)).toBe(300_000);
		expect(thresholdFor(settings, unmatched)).toBe(150_000);
	});

	it("re-resolves the session gauge for the live model after a model switch", async () => {
		const settings = Settings.isolated({
			"compaction.thresholdPercent": 80,
			"compaction.modelThresholds": { "anthropic/*": 600_000, "openai/*": "50%" },
		});
		authStorage = await AuthStorage.create(":memory:");
		session = new AgentSession({
			agent: new Agent({ initialState: { model: claude, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		expect(computeSessionContextBreakdown(session).thresholdTokens).toBe(600_000);
		expect(getSessionCompactionBoundaries(settings, claude.contextWindow, session.model)?.thresholdPercent).toBe(60);

		session.agent.setModel(gpt);
		expect(computeSessionContextBreakdown(session).thresholdTokens).toBe(200_000);
		expect(getSessionCompactionBoundaries(settings, gpt.contextWindow, session.model)?.thresholdPercent).toBe(50);

		session.agent.setModel(unmatched);
		expect(computeSessionContextBreakdown(session).thresholdTokens).toBe(160_000);
	});

	it("keeps a subagent's task.agentCompactionThresholdOverrides entry ahead of model thresholds", () => {
		const parent = Settings.isolated({
			"compaction.thresholdPercent": 80,
			"compaction.modelThresholds": { "anthropic/*": 600_000 },
		});

		const pinned = createSubagentSettings(parent, undefined, {
			agentCompactionThreshold: { thresholdPercent: 25, thresholdTokens: -1 },
		});
		expect(thresholdFor(pinned, claude)).toBe(250_000);

		// Children without an entry, including those spawned by a pinned agent, resolve model thresholds.
		expect(thresholdFor(createSubagentSettings(parent), claude)).toBe(600_000);
		expect(thresholdFor(createSubagentSettings(pinned), claude)).toBe(600_000);
		expect(thresholdFor(createSubagentSettings(pinned), unmatched)).toBe(160_000);
	});
});
