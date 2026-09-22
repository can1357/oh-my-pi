import { describe, expect, test } from "bun:test";
import { compileCascade } from "../scripts/compat-compiler/compile-cascade";
import { AmbiguousOverlapError, globMatch, resolveCascade, resolveCascadeRules } from "../src/compat/cascade";
import type { CompiledCascade, ResolveTarget } from "../src/compat/types";

function compile(text: string) {
	return compileCascade([{ file: "classes/test.kdl", text }]);
}

const target = (overrides: Partial<ResolveTarget>): ResolveTarget => ({
	provider: "prov",
	api: "api",
	class: "cls",
	model: "model-1",
	reasoning: true,
	...overrides,
});

describe("cascade rank precedence", () => {
	test("exact model selector outranks glob outranks selector-free", () => {
		const cascade = compile(
			`class "cls" {
				supports-store #false
				models "model-*" {
					supports-store #true
				}
				models "model-1" {
					max-tokens-field "max_tokens"
					supports-store #false
				}
			}`,
		);
		const resolved = resolveCascadeRules(cascade, target({}));
		expect(resolved.wire.supportsStore).toBe(false);
		expect(resolved.wire.maxTokensField).toBe("max_tokens");
		// The glob wins for a sibling id the exact selector misses.
		expect(resolveCascadeRules(cascade, target({ model: "model-2" })).wire.supportsStore).toBe(true);
	});

	test("more constrained dimensions win at equal exactness", () => {
		const cascade = compile(
			`class "cls" {
				supports-store #true
				family "fam" {
					supports-store #false
				}
			}`,
		);
		expect(resolveCascadeRules(cascade, target({ family: "fam" })).wire.supportsStore).toBe(false);
		expect(resolveCascadeRules(cascade, target({})).wire.supportsStore).toBe(true);
	});

	test("API selectors match independently of custom provider names", () => {
		const cascade = compile(
			`class "cls" {
				on-api "google-generative-ai" {
					requires-skip-thought-signature #true
				}
			}`,
		);

		expect(resolveCascadeRules(cascade, target({ api: "google-generative-ai" })).wire).toMatchObject({
			requiresSkipThoughtSignature: true,
		});
		expect(resolveCascadeRules(cascade, target({ api: "google-vertex" })).wire).toEqual({});
	});

	test("priority breaks intentional equal-specificity overlap", () => {
		const cascade = compile(
			`class "cls" {
				family "fam" {
					supports-store #true
				}
				revision ">=2" priority=1 {
					supports-store #false
				}
			}`,
		);
		expect(resolveCascadeRules(cascade, target({ family: "fam", revision: "2.5.0" })).wire.supportsStore).toBe(false);
	});

	test("equal-rank same-axis conflict throws AmbiguousOverlap", () => {
		const cascade = compile(
			`class "cls" {
				family "fam" {
					supports-store #true
				}
				revision ">=2" {
					supports-store #false
				}
			}`,
		);
		expect(() => resolveCascadeRules(cascade, target({ family: "fam", revision: "2.5.0" }))).toThrow(
			AmbiguousOverlapError,
		);
	});

	test("revision range conjunctions must all hold and need a ranked target", () => {
		const cascade = compile(
			`class "cls" {
				revision ">=2.5 <3.8" {
					supports-store #false
				}
			}`,
		);
		expect(resolveCascadeRules(cascade, target({ revision: "2.5.0" })).wire.supportsStore).toBe(false);
		expect(resolveCascadeRules(cascade, target({ revision: "3.8.0" })).wire.supportsStore).toBeUndefined();
		expect(resolveCascadeRules(cascade, target({})).wire.supportsStore).toBeUndefined();
	});

	test("thinking axes are reasoning-gated except exact-selector upgrades", () => {
		const cascade = compile(
			`class "cls" {
				thinking-mode "effort"
				models "model-1" {
					thinking-efforts "low" "high"
				}
			}`,
		);
		// Broad thinking rules never leak onto a non-reasoning sibling…
		const inert = resolveCascadeRules(cascade, target({ model: "model-2", reasoning: false }));
		expect(Object.keys(inert.thinking)).toEqual([]);
		// …but an exact-selector efforts rule upgrades its target.
		const upgraded = resolveCascadeRules(cascade, target({ model: "model-1", reasoning: false }));
		expect(upgraded.thinking.efforts).toEqual(["low", "high"]);
		expect(upgraded.thinking.mode).toBe("effort");
	});

	test("identity-scoped neutral opt-in activates reviewed class and revision ladders only", () => {
		const cascade = compile(
			`provider "prov" {
				thinking-upgrade-neutral #true
				thinking-efforts "minimal" "low"
				class "cls" {
					thinking-upgrade-neutral #true
					revision ">=2" {
						thinking-efforts "low" "medium" "xhigh"
					}
				}
				class "other" {
					revision ">=2" {
						thinking-efforts "high" "max"
					}
				}
			}`,
		);

		const upgraded = resolveCascadeRules(cascade, target({ revision: "2.1", reasoning: false }));
		expect(upgraded.reasoning).toBe(true);
		expect(upgraded.thinking.efforts).toEqual(["low", "medium", "xhigh"]);
		expect(upgraded.thinking.upgradeNeutral).toBe(true);

		// Provider-wide opt-in is intentionally insufficient: it must not turn
		// every neutral discovery row into a reasoning model.
		const unrelated = resolveCascadeRules(
			cascade,
			target({ class: "other", model: "other-model", revision: "2.1", reasoning: false }),
		);
		expect(unrelated.reasoning).toBe(false);
		expect(unrelated.thinking).toEqual({});
	});

	test("compound wildcard and token selectors preserve conjunction semantics", () => {
		const cascade: CompiledCascade = {
			rules: [
				{
					source: "global",
					wire: { supportsStore: false },
				},
				{
					source: "compound",
					class: "cls",
					providers: ["prov"],
					apis: ["api"],
					family: "fam",
					revision: [
						{ op: ">=", revision: "2.0.0" },
						{ op: "<", revision: "3.0.0" },
					],
					models: [
						{ kind: "glob", value: "model-*-pro" },
						{ kind: "token", value: "preview" },
					],
					wire: { supportsStore: true, maxTokensField: "max_completion_tokens" },
				},
			],
		};

		for (const model of ["MODEL-X-PRO", "acme-preview-v2"]) {
			expect(resolveCascadeRules(cascade, target({ family: "fam", revision: "2.4", model })).wire).toEqual({
				supportsStore: true,
				maxTokensField: "max_completion_tokens",
			});
		}
		expect(
			resolveCascadeRules(cascade, target({ family: "other", revision: "2.4", model: "MODEL-X-PRO" })).wire,
		).toEqual({
			supportsStore: false,
		});
		expect(resolveCascadeRules(cascade, target({ family: "fam", revision: "3", model: "MODEL-X-PRO" })).wire).toEqual(
			{
				supportsStore: false,
			},
		);
	});

	test("candidate buckets retain declaration order for ambiguity diagnostics", () => {
		const cascade: CompiledCascade = {
			rules: [
				{ source: "provider-first", providers: ["prov"], wire: { supportsStore: true } },
				{ source: "irrelevant", providers: ["other"], wire: { supportsStore: true } },
				{ source: "class-second", class: "cls", wire: { supportsStore: false } },
			],
		};

		let caught: unknown;
		try {
			resolveCascadeRules(cascade, target({}));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AmbiguousOverlapError);
		expect(caught).toMatchObject({
			axis: "supportsStore",
			first: "provider-first",
			second: "class-second",
		});
	});

	test("custom cascades are isolated from result mutation and one another", () => {
		const first: CompiledCascade = {
			rules: [
				{
					source: "first",
					class: "cls",
					wire: { reasoningEffortMap: { low: "minimal" } },
				},
			],
		};
		const second: CompiledCascade = {
			rules: [
				{
					source: "second",
					class: "cls",
					wire: { reasoningEffortMap: { low: "low" } },
				},
			],
		};

		const mutated = resolveCascadeRules(first, target({}));
		(mutated.wire.reasoningEffortMap as Record<string, string>).low = "poisoned";
		expect(resolveCascadeRules(first, target({})).wire.reasoningEffortMap).toEqual({ low: "minimal" });
		expect(resolveCascadeRules(second, target({})).wire.reasoningEffortMap).toEqual({ low: "low" });
	});
});

describe("resolveCascade over committed rules", () => {
	test("bundled rules resolve thinking for a reasoning glm target", () => {
		const resolved = resolveCascade({
			provider: "opencode-zen",
			api: "openai-completions",
			class: "glm",
			model: "glm-5.2",
			reasoning: true,
		});
		expect(resolved.thinking.mode).toBeDefined();
	});

	test("glm-5.2 on a blanket-glm provider resolves without overlapping the class ladder", () => {
		// Regression: providers/alibaba-coding-plan.kdl has a direct `class "glm"`
		// efforts block and no exact glm-5.2 residue, so it used to tie with the
		// classes/glm.kdl revision >=5.2 ladder and throw AmbiguousOverlapError.
		const resolved = resolveCascade({
			provider: "alibaba-coding-plan",
			api: "openai-completions",
			class: "glm",
			model: "glm-5.2",
			revision: "5.2",
			reasoning: true,
		});
		expect(resolved.thinking.efforts).toEqual(["minimal", "low", "medium", "high", "max"]);
	});

	test("memoized bundled results cannot be contaminated by consumers", () => {
		const lookup: ResolveTarget = {
			provider: "alibaba-coding-plan",
			api: "openai-completions",
			class: "glm",
			model: "glm-5.2",
			revision: "5.2",
			reasoning: true,
		};
		const first = resolveCascade({ ...lookup });
		(first.thinking.efforts as string[])[0] = "poisoned";
		first.thinking.mode = "poisoned";

		const repeated = resolveCascade({ ...lookup });
		expect(repeated.thinking.efforts).toEqual(["minimal", "low", "medium", "high", "max"]);
		expect(repeated.thinking.mode).not.toBe("poisoned");
		expect(repeated).not.toBe(first);
		expect(repeated.thinking.efforts).not.toBe(first.thinking.efforts);
		expect(resolveCascade({ ...lookup, reasoning: false }).thinking).toEqual({});
	});

	test("glob matching is anchored and case-insensitive", () => {
		expect(globMatch("gpt-*-codex", "gpt-5.2-codex")).toBe(true);
		expect(globMatch("gpt-*-codex", "xgpt-5.2-codex")).toBe(false);
		expect(globMatch("gpt-*-codex", "gpt-5.2-codex-mini")).toBe(false);
		expect(globMatch("*sonnet*", "claude-sonnet-4-5")).toBe(true);
	});
});
