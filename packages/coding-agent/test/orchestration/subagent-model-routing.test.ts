import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	resolveSubagentModelRouting,
	type SubagentModelRoutingRegistry,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/subagent-model-routing";

function makeModel(provider: string, id: string, name: string): Model<Api> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function makeRegistry(models: Model<Api>[]): SubagentModelRoutingRegistry {
	return {
		getAvailable: () => models,
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	} as unknown as SubagentModelRoutingRegistry;
}

const smolModel = makeModel("anthropic", "claude-haiku", "Claude Haiku");
const taskModel = makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet");
const slowModel = makeModel("anthropic", "claude-opus-4-8", "Claude Opus");
const gpt4o = makeModel("openai", "gpt-4o", "GPT-4o");
const profileSmolModel = makeModel("openai", "gpt-4o-mini", "GPT-4o mini");

const registry = makeRegistry([smolModel, taskModel, slowModel, gpt4o, profileSmolModel]);

const baseModelRoles = {
	smol: "anthropic/claude-haiku",
	task: "anthropic/claude-sonnet-4-5",
	slow: "anthropic/claude-opus-4-8",
};

describe("resolveSubagentModelRouting — precedence branches", () => {
	test("explicit model wins over requested difficulty", () => {
		const settings = Settings.isolated({ modelRoles: baseModelRoles });
		const result = resolveSubagentModelRouting({
			requestedModel: "openai/gpt-4o",
			requestedDifficulty: "high",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("explicit");
		expect(result.decision.requestedDifficulty).toBe("high");
		expect(result.modelPatterns).toEqual(["openai/gpt-4o"]);
	});

	test("requested difficulty wins over per-agent override", () => {
		const settings = Settings.isolated({
			modelRoles: baseModelRoles,
			"task.agentModelOverrides": { explore: "openai/gpt-4o" },
		});
		const result = resolveSubagentModelRouting({
			requestedDifficulty: "low",
			agentName: "explore",
			agentModelDefault: "openai/gpt-4o",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("difficulty-profile");
		expect(result.decision.role).toBe("smol");
		expect(result.modelPatterns).toEqual(["pi/smol"]);
	});

	test("per-agent override wins over agent definition", () => {
		const settings = Settings.isolated({
			"task.agentModelOverrides": { explore: "openai/gpt-4o" },
		});
		const result = resolveSubagentModelRouting({
			agentName: "explore",
			agentModelDefault: "anthropic/claude-sonnet-4-5",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("agent-override");
		expect(result.modelPatterns).toEqual(["openai/gpt-4o"]);
	});

	test("agent definition wins over parent-active fallback", () => {
		const settings = Settings.isolated();
		const result = resolveSubagentModelRouting({
			agentName: "explore",
			agentModelDefault: "anthropic/claude-sonnet-4-5",
			parentActiveModelPattern: "openai/gpt-4o",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("agent-definition");
		expect(result.modelPatterns).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	test("parent-active model is used before session default", () => {
		const settings = Settings.isolated();
		const result = resolveSubagentModelRouting({
			agentName: "explore",
			parentActiveModelPattern: "openai/gpt-4o",
			sessionDefaultModelPattern: "anthropic/claude-opus-4-8",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("parent-active");
		expect(result.modelPatterns).toEqual(["openai/gpt-4o"]);
	});

	test("session default is the final fallback", () => {
		const settings = Settings.isolated();
		const result = resolveSubagentModelRouting({
			agentName: "explore",
			sessionDefaultModelPattern: "anthropic/claude-opus-4-8",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("session-default");
		expect(result.modelPatterns).toEqual(["anthropic/claude-opus-4-8"]);
	});
});

describe("resolveSubagentModelRouting — named agent profiles", () => {
	test("active named profile supplies the difficulty role's concrete model", () => {
		const settings = Settings.isolated({
			"agent.profile": "budget",
			"agent.profiles": { budget: { smol: "openai/gpt-4o-mini" } },
		});
		const result = resolveSubagentModelRouting({
			requestedDifficulty: "low",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("difficulty-profile");
		expect(result.decision.profileName).toBe("budget");
		expect(result.modelPatterns).toEqual(["pi/smol"]);
	});

	test("explicit modelRoles overrides the active profile's role for the same difficulty", () => {
		const settings = Settings.isolated({
			modelRoles: { smol: "anthropic/claude-haiku" },
			"agent.profile": "budget",
			"agent.profiles": { budget: { smol: "openai/gpt-4o-mini" } },
		});
		const result = resolveSubagentModelRouting({
			requestedDifficulty: "low",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// profileName is provenance for the ACTIVE role source only: since
		// explicit `modelRoles.smol` wins, the profile did not supply the
		// resolved role, so profileName must be absent (not "budget").
		expect(result.decision.profileName).toBeUndefined();
		const roleResolution = resolveSubagentModelRouting({
			requestedModel: "pi/smol",
			settings,
			modelRegistry: registry,
		});
		expect(roleResolution.ok).toBe(true);
	});

	test("profileName is absent when the active profile does not configure the requested role", () => {
		const settings = Settings.isolated({
			modelRoles: baseModelRoles,
			"agent.profile": "budget",
			"agent.profiles": { budget: { task: "anthropic/claude-sonnet-4-5" } },
		});
		const result = resolveSubagentModelRouting({
			requestedDifficulty: "low",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.profileName).toBeUndefined();
	});
});

describe("resolveSubagentModelRouting — explicit and difficulty coexistence", () => {
	test("explicit model and requested difficulty may coexist; explicit wins, difficulty is recorded", () => {
		const settings = Settings.isolated({ modelRoles: baseModelRoles });
		const result = resolveSubagentModelRouting({
			requestedModel: "anthropic/claude-haiku",
			requestedDifficulty: "medium",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("explicit");
		expect(result.decision.requestedDifficulty).toBe("medium");
	});
});

describe("resolveSubagentModelRouting — failure without silent downgrade", () => {
	test("unavailable difficulty role fails clearly instead of falling back to a lower difficulty", () => {
		const settings = Settings.isolated({
			modelRoles: { smol: "anthropic/claude-haiku", task: "anthropic/claude-sonnet-4-5" },
		});
		const emptyRegistry = makeRegistry([]);
		const result = resolveSubagentModelRouting({
			requestedDifficulty: "high",
			settings,
			modelRegistry: emptyRegistry,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("difficulty-role-unavailable");
		expect(result.error.requestedDifficulty).toBe("high");
		expect(result.error.candidateSelectors.length).toBeGreaterThan(0);
	});

	test("unresolved explicit model selector fails clearly", () => {
		const settings = Settings.isolated();
		const result = resolveSubagentModelRouting({
			requestedModel: "totally-unknown-selector-xyz",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("explicit-model-unresolved");
	});

	test("unavailable difficulty role does not fall back to per-agent-override/agent-definition/session-default", () => {
		const settings = Settings.isolated({
			modelRoles: { smol: "anthropic/claude-haiku", task: "anthropic/claude-sonnet-4-5" },
			"task.agentModelOverrides": { explore: "openai/gpt-4o" },
		});
		const emptyRegistry = makeRegistry([]);
		const result = resolveSubagentModelRouting({
			requestedDifficulty: "high",
			agentName: "explore",
			agentModelDefault: "anthropic/claude-sonnet-4-5",
			sessionDefaultModelPattern: "anthropic/claude-opus-4-8",
			settings,
			modelRegistry: emptyRegistry,
		});

		expect(result.ok).toBe(false);
	});
});

describe("resolveSubagentModelRouting — modelRegistry is optional", () => {
	test("legacy no-model/no-difficulty routes resolve without a registry", () => {
		const settings = Settings.isolated();
		const result = resolveSubagentModelRouting({
			agentName: "explore",
			agentModelDefault: "anthropic/claude-sonnet-4-5",
			sessionDefaultModelPattern: "anthropic/claude-opus-4-8",
			settings,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.source).toBe("agent-definition");
		expect(result.modelPatterns).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	test("explicit model route fails with its typed preallocation error when the registry is absent", () => {
		const settings = Settings.isolated();
		const result = resolveSubagentModelRouting({
			requestedModel: "anthropic/claude-haiku",
			settings,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("explicit-model-unresolved");
	});

	test("difficulty route fails with its typed preallocation error when the registry is absent", () => {
		const settings = Settings.isolated({ modelRoles: baseModelRoles });
		const result = resolveSubagentModelRouting({
			requestedDifficulty: "medium",
			settings,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("difficulty-role-unavailable");
		expect(result.error.requestedDifficulty).toBe("medium");
	});
});

describe("resolveSubagentModelRouting — immutability", () => {
	test("decision and candidateSelectors are frozen", () => {
		const settings = Settings.isolated({ modelRoles: baseModelRoles });
		const result = resolveSubagentModelRouting({
			requestedDifficulty: "medium",
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.decision)).toBe(true);
		expect(Object.isFrozen(result.decision.candidateSelectors)).toBe(true);
		expect(Object.isFrozen(result.modelPatterns)).toBe(true);
	});

	test("mutating the caller's requestedModel array cannot change decision.requestedModel", () => {
		const settings = Settings.isolated();
		const callerModels = ["anthropic/claude-haiku", "openai/gpt-4o"];
		const result = resolveSubagentModelRouting({
			requestedModel: callerModels,
			settings,
			modelRegistry: registry,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.requestedModel).toEqual(["anthropic/claude-haiku", "openai/gpt-4o"]);
		expect(Object.isFrozen(result.decision.requestedModel)).toBe(true);

		callerModels.push("mutated/should-not-appear");
		callerModels[0] = "mutated/should-not-replace";

		expect(result.decision.requestedModel).toEqual(["anthropic/claude-haiku", "openai/gpt-4o"]);
	});
});
