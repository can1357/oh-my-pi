import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { generateChangelogEntries } from "@oh-my-pi/pi-coding-agent/commit/changelog/generate";
import { DEFAULT_CONVENTIONAL_GENERATION_CONFIG } from "@oh-my-pi/pi-coding-agent/commit/conventional/config";
import {
	type CommitInferenceRequest,
	OmpCommitInference,
} from "@oh-my-pi/pi-coding-agent/commit/conventional/inference";
import { generateCommitMessage } from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";

const EFFORT_LADDER = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max];

function makeModel(provider: string, id: string): Model<"openai-completions"> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [...EFFORT_LADDER] },
		compat: {
			thinkingFormat: "openai",
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 1, output: 1 },
	} as unknown as AssistantMessage;
}

function assistantError(message: string): AssistantMessage {
	return { ...assistantText(""), stopReason: "error", errorMessage: message };
}
/** Spy on the barrel so production `completeSimple` calls land here; returns calls in invocation order. */
function spyCompleteSimple(respond: (call: CapturedCall) => AssistantMessage): CapturedCall[] {
	const calls: CapturedCall[] = [];
	vi.spyOn(ai, "completeSimple").mockImplementation((model, _context, options) => {
		const call: CapturedCall = {
			modelId: model.id,
			options: (options ?? {}) as CapturedCall["options"],
		};
		calls.push(call);
		return Promise.resolve(respond(call));
	});
	return calls;
}

interface CapturedCall {
	modelId: string;
	options: Pick<SimpleStreamOptions, "reasoning" | "serviceTier">;
}

function createSettings(opts: { smolRole?: string; tierOverrides?: Record<string, string> }) {
	return {
		get(path: string) {
			if (path === "tier.modelOverrides") return opts.tierOverrides;
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? opts.smolRole : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(models: Model<"openai-completions">[]) {
	return {
		getAvailable: () => models,
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false as const },
		resolver: () => async () => "test-key",
	} as never;
}

function inferenceRequest(role: CommitInferenceRequest["role"]): CommitInferenceRequest {
	return {
		operation: `op-${role}`,
		role,
		promptFamily: "analysis",
		systemPrompt: "system",
		userPrompt: "user",
		toolName: "commit_tool",
		progressLabel: "Generating",
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("commit message generator service tiers", () => {
	it("tiers the configured smol at its actual max effort and resolves the fallback candidate independently", async () => {
		const maxSmol = makeModel("openai", "commit-tier-max");
		const fallback = makeModel("openai", "commit-tier-fallback");
		const calls = spyCompleteSimple(call =>
			call.modelId === "commit-tier-max" ? assistantError("model not found") : assistantText("Fix login redirect"),
		);
		const settings = createSettings({
			smolRole: "openai/commit-tier-max:max",
			tierOverrides: { "openai/commit-tier-max:max": "priority" },
		});

		const message = await generateCommitMessage("diff", createRegistry([maxSmol, fallback]), settings);

		expect(message).toBe("Fix login redirect");
		expect(calls[0]?.modelId).toBe("commit-tier-max");
		expect(calls[0]?.options.reasoning).toBe(Effort.Max);
		expect(calls[0]?.options.serviceTier).toBe("priority");
		expect(calls.at(-1)?.modelId).toBe("commit-tier-fallback");
		expect(calls.at(-1)?.options.reasoning).toBeUndefined();
		expect(calls.at(-1)?.options.serviceTier).toBeUndefined();
	});

	it("keeps an effort-qualified override inert when the smol request runs at a lower effort", async () => {
		const smol = makeModel("openai", "commit-tier-max");
		const calls = spyCompleteSimple(() => assistantText("Fix login redirect"));
		const settings = createSettings({
			smolRole: "openai/commit-tier-max:high",
			tierOverrides: { "openai/commit-tier-max:max": "priority" },
		});

		const message = await generateCommitMessage("diff", createRegistry([smol]), settings);

		expect(message).toBe("Fix login redirect");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.reasoning).toBe(Effort.High);
		expect(calls[0]?.options.serviceTier).toBeUndefined();
	});

	it("respects an explicit none override by leaving the tier off the wire", async () => {
		const smol = makeModel("openai", "commit-tier-max");
		const calls = spyCompleteSimple(() => assistantText("Fix login redirect"));
		const settings = createSettings({
			smolRole: "openai/commit-tier-max:max",
			tierOverrides: { "openai/commit-tier-max": "none" },
		});

		const message = await generateCommitMessage("diff", createRegistry([smol]), settings);

		expect(message).toBe("Fix login redirect");
		expect(calls[0]?.options.reasoning).toBe(Effort.Max);
		expect(calls[0]?.options.serviceTier).toBeUndefined();
	});

	it("keeps the tier omitted entirely when no override matches", async () => {
		const smol = makeModel("openai", "commit-tier-max");
		const calls = spyCompleteSimple(() => assistantText("Fix login redirect"));
		const settings = createSettings({
			smolRole: "openai/commit-tier-max:max",
			tierOverrides: { "openai/other-model": "priority" },
		});

		await generateCommitMessage("diff", createRegistry([smol]), settings);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.serviceTier).toBeUndefined();
	});
});

describe("conventional commit inference service tiers", () => {
	it("resolves the tier per actual inference target, effort keys beating base keys", async () => {
		const primary = makeModel("openai", "commit-primary");
		const smol = makeModel("openai", "commit-smol");
		const calls = spyCompleteSimple(() => assistantText("feat(scope): add flag"));
		const inference = new OmpCommitInference({
			primary: { model: primary, apiKey: "test-key", thinkingLevel: Effort.Max },
			smol: { model: smol, apiKey: "test-key" },
			config: { ...DEFAULT_CONVENTIONAL_GENERATION_CONFIG, maxRetries: 1 },
			cache: null,
			modelServiceTierOverrides: {
				"openai/commit-primary": "flex",
				"openai/commit-primary:max": "priority",
				"openai/commit-smol": "scale",
			},
		});

		const parse = (response: { text: string }) => response.text;
		await inference.complete(inferenceRequest("analysis"), parse);
		await inference.complete(inferenceRequest("summary"), parse);
		inference.dispose();

		expect(calls[0]?.modelId).toBe("commit-primary");
		expect(calls[0]?.options.reasoning).toBe(Effort.Max);
		expect(calls[0]?.options.serviceTier).toBe("priority");
		expect(calls[1]?.modelId).toBe("commit-smol");
		expect(calls[1]?.options.reasoning).toBeUndefined();
		expect(calls[1]?.options.serviceTier).toBe("scale");
	});

	it("keeps untiered targets omitted and follows the actual target when the primary stands in for every role", async () => {
		const primary = makeModel("openai", "commit-primary");
		const smol = makeModel("openai", "commit-smol");
		const calls = spyCompleteSimple(() => assistantText("feat(scope): add flag"));
		const parse = (response: { text: string }) => response.text;
		const baseConfig = { ...DEFAULT_CONVENTIONAL_GENERATION_CONFIG, maxRetries: 1 };

		const untiered = new OmpCommitInference({
			primary: { model: primary, apiKey: "test-key", thinkingLevel: Effort.Max },
			smol: { model: smol, apiKey: "test-key" },
			config: baseConfig,
			cache: null,
			modelServiceTierOverrides: { "openai/unrelated": "priority" },
		});
		await untiered.complete(inferenceRequest("summary"), parse);
		untiered.dispose();
		expect(calls[0]?.modelId).toBe("commit-smol");
		expect(calls[0]?.options.serviceTier).toBeUndefined();

		const forced = new OmpCommitInference({
			primary: { model: primary, apiKey: "test-key", thinkingLevel: Effort.Max },
			smol: { model: smol, apiKey: "test-key" },
			forcePrimaryForEveryRole: true,
			config: baseConfig,
			cache: null,
			modelServiceTierOverrides: { "openai/commit-smol": "priority" },
		});
		await forced.complete(inferenceRequest("summary"), parse);
		forced.dispose();
		expect(calls[1]?.modelId).toBe("commit-primary");
		expect(calls[1]?.options.serviceTier).toBeUndefined();
	});
});

describe("changelog generation service tiers", () => {
	it("forwards the matched model override tier and omits it for lower efforts or absent overrides", async () => {
		const model = makeModel("openai", "commit-changelog");
		const calls = spyCompleteSimple(() => assistantText(JSON.stringify({ entries: { Added: ["New flag"] } })));
		const base = {
			model,
			apiKey: "test-key",
			sessionId: "sess-changelog",
			changelogPath: "CHANGELOG.md",
			isPackageChangelog: false,
			stat: "1 file changed",
			diff: "diff --git a/x b/x",
		};

		const tiered = await generateChangelogEntries({
			...base,
			thinkingLevel: Effort.Max,
			modelServiceTierOverrides: { "openai/commit-changelog:max": "priority" },
		});
		expect(tiered.entries.Added).toEqual(["New flag"]);
		expect(calls[0]?.options.reasoning).toBe(Effort.Max);
		expect(calls[0]?.options.serviceTier).toBe("priority");

		await generateChangelogEntries({
			...base,
			thinkingLevel: Effort.High,
			modelServiceTierOverrides: { "openai/commit-changelog:max": "priority" },
		});
		expect(calls[1]?.options.serviceTier).toBeUndefined();

		await generateChangelogEntries({ ...base, thinkingLevel: Effort.Max });
		expect(calls[2]?.options.reasoning).toBe(Effort.Max);
		expect(calls[2]?.options.serviceTier).toBeUndefined();
	});
});
