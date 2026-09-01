import { describe, expect, it } from "bun:test";
import type { ModelEquivalence, ModelRoute } from "@oh-my-pi/pi-ai/auth-gateway/model-route";
import { parseModelRoute } from "@oh-my-pi/pi-ai/auth-gateway/model-route";

const EQUIVALENCE: readonly ModelEquivalence[] = ["exact", "family", "capability", "explicit"];

describe("parseModelRoute", () => {
	it("splits anthropic/claude-opus on the first slash", () => {
		expect(parseModelRoute("anthropic/claude-opus")).toEqual({
			provider: "anthropic",
			concreteModel: "claude-opus",
		});
	});

	it("leaves a bare gpt-5 with no provider", () => {
		const parsed = parseModelRoute("gpt-5");
		expect(parsed.concreteModel).toBe("gpt-5");
		expect(parsed.provider).toBeUndefined();
		expect("provider" in parsed).toBe(false);
	});

	it("keeps everything after the first slash as concreteModel", () => {
		expect(parseModelRoute("openrouter/meta/llama-3")).toEqual({
			provider: "openrouter",
			concreteModel: "meta/llama-3",
		});
	});

	it("does not split on hyphen (negative)", () => {
		const parsed = parseModelRoute("anthropic-claude-opus");
		expect(parsed.provider).toBeUndefined();
		expect(parsed.concreteModel).toBe("anthropic-claude-opus");
	});

	it("does not treat similar concrete names as equivalent (negative)", () => {
		const opus = parseModelRoute("anthropic/claude-opus");
		const opus4 = parseModelRoute("anthropic/claude-opus-4");
		expect(opus.provider).toBe("anthropic");
		expect(opus4.provider).toBe("anthropic");
		expect(opus.concreteModel).toBe("claude-opus");
		expect(opus4.concreteModel).toBe("claude-opus-4");
		expect(opus.concreteModel).not.toBe(opus4.concreteModel);
	});

	it("does not case-fold or trim (negative)", () => {
		expect(parseModelRoute("Anthropic/Claude-Opus")).toEqual({
			provider: "Anthropic",
			concreteModel: "Claude-Opus",
		});
		expect(parseModelRoute(" anthropic/claude-opus")).toEqual({
			provider: " anthropic",
			concreteModel: "claude-opus",
		});
	});

	it("splits a leading slash as an empty provider (negative)", () => {
		expect(parseModelRoute("/claude-opus")).toEqual({
			provider: "",
			concreteModel: "claude-opus",
		});
	});
});

describe("ModelRoute", () => {
	it("records explicit equivalence rather than inferring from similar names", () => {
		const exact: ModelRoute = {
			logicalModel: "opus",
			provider: "anthropic",
			concreteModel: "claude-opus",
			protocol: "anthropic-messages",
			equivalence: "exact",
		};
		const family: ModelRoute = {
			logicalModel: "opus",
			provider: "anthropic",
			concreteModel: "claude-opus-4",
			protocol: "anthropic-messages",
			equivalence: "family",
		};
		expect(EQUIVALENCE).toContain(exact.equivalence);
		expect(EQUIVALENCE).toContain(family.equivalence);
		expect(exact.concreteModel).not.toBe(family.concreteModel);
		expect(exact.equivalence).not.toBe(family.equivalence);
	});
});
