import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";

function createContext(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string> = {},
): RetryFallbackResolutionContext {
	const models = [
		getBundledModel("google", "gemini-2.5-flash"),
		getBundledModel("google-vertex", "gemini-2.5-flash"),
		getBundledModel("openrouter", "google/gemini-2.5-flash"),
		getBundledModel("openai", "gpt-4o-mini"),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
		},
	};
}

describe("retry fallback selector resolution", () => {
	it("resolves chain keys by exact model, longest wildcard, role, then default", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const exactContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
				[selector]: ["google/gemini-2.5-flash"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(exactContext, selector, undefined, "task")).toBe(selector);

		const wildcardContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(wildcardContext, selector, undefined, "task")).toBe("openrouter/google/*");

		const roleContext = createContext(
			{ default: ["openai/gpt-4o-mini"], task: ["google/gemini-2.5-flash"] },
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(roleContext, selector, undefined, "task")).toBe("task");

		const defaultContext = createContext({ default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(defaultContext, selector)).toBe("default");
	});

	it("does not let a later shared-assignment role steal the default chain", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext(
			{
				vision: ["openai/gpt-4o-mini"],
				default: ["google/gemini-2.5-flash"],
			},
			{ default: selector, vision: selector },
		);
		expect(resolveRetryFallbackChainKey(context, selector)).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "default")).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "vision")).toBe("vision");
	});

	it("uses a hinted role chain when its unqualified primary cannot resolve", () => {
		const context = createContext({ task: ["openai/gpt-4o-mini"] });
		const chainKey = resolveRetryFallbackChainKey(context, "missing-model:high", undefined, "task");
		expect(chainKey).toBe("task");
		if (!chainKey) throw new Error("Expected hinted role fallback chain");
		expect(
			findRetryFallbackCandidates(context, chainKey, "missing-model:high", undefined, {
				allowMissingPrimary: true,
			}),
		).toEqual([
			{
				raw: "openai/gpt-4o-mini",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);
	});

	it("stops a role chain when its primary assignment is removed at runtime", () => {
		const context = createContext({
			slow: ["google/gemini-2.5-flash", "openai/gpt-4o-mini"],
		});
		expect(findRetryFallbackCandidates(context, "slow", "google/gemini-2.5-flash")).toEqual([]);
	});

	it("expands wildcard candidates from the current selector", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext({ "openrouter/google/*": ["google-vertex/*"] });
		const candidates = findRetryFallbackCandidates(context, "openrouter/google/*", selector);
		expect(candidates).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("inherits the default chain only for roles without an explicit chain", () => {
		const defaultChain = ["openai/gpt-4o-mini"];
		const expanded = expandDefaultRetryFallbackChains({ default: defaultChain, slow: ["google/gemini-2.5-flash"] }, [
			"default",
			"task",
			"slow",
		]);
		expect(expanded.task).toBe(defaultChain);
		expect(expanded.slow).toEqual(["google/gemini-2.5-flash"]);
	});
});
