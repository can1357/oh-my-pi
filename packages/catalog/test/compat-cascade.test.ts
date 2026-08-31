import { describe, expect, test } from "bun:test";
import { compileCascade } from "../scripts/compat-compiler/compile-cascade";
import { AmbiguousOverlapError, globMatch, resolveCascade, resolveCascadeRules } from "../src/compat/cascade";
import type { ResolveTarget } from "../src/compat/types";

function compile(text: string) {
	return compileCascade([{ file: "classes/test.kdl", text }]);
}

const target = (overrides: Partial<ResolveTarget>): ResolveTarget => ({
	provider: "prov",
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
});

describe("resolveCascade over committed rules", () => {
	test("bundled rules resolve thinking for a reasoning glm target", () => {
		const resolved = resolveCascade({
			provider: "opencode-zen",
			class: "glm",
			model: "glm-5.2",
			reasoning: true,
		});
		expect(resolved.thinking.mode).toBeDefined();
	});

	test("glob matching is anchored and case-insensitive", () => {
		expect(globMatch("gpt-*-codex", "gpt-5.2-codex")).toBe(true);
		expect(globMatch("gpt-*-codex", "xgpt-5.2-codex")).toBe(false);
		expect(globMatch("gpt-*-codex", "gpt-5.2-codex-mini")).toBe(false);
		expect(globMatch("*sonnet*", "claude-sonnet-4-5")).toBe(true);
	});
});
