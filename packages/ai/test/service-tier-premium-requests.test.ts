import { describe, expect, it } from "bun:test";
import { getPriorityPremiumRequests, resolveServiceTier, shouldSendServiceTier } from "@pk-nerdsaver-ai/pi-ai/types";

describe("getPriorityPremiumRequests", () => {
	it("counts priority tier as one premium request on OpenAI", () => {
		expect(getPriorityPremiumRequests("priority", "openai")).toBe(1);
	});

	it("counts priority tier as one premium request on OpenAI Codex", () => {
		expect(getPriorityPremiumRequests("priority", "openai-codex")).toBe(1);
	});

	it("ignores non-priority paid tiers", () => {
		expect(getPriorityPremiumRequests("flex", "openai")).toBe(0);
		expect(getPriorityPremiumRequests("scale", "openai")).toBe(0);
	});

	it("ignores default and auto tiers", () => {
		expect(getPriorityPremiumRequests("default", "openai")).toBe(0);
		expect(getPriorityPremiumRequests("auto", "openai")).toBe(0);
	});

	it("ignores priority tier on providers that drop service_tier", () => {
		// `priority` is realized on `openai`, `openai-codex`, and direct `anthropic`
		// (as fast mode). Everywhere else it's silently dropped, so it must not
		// be billed as premium.
		expect(getPriorityPremiumRequests("priority", "github-copilot")).toBe(0);
		expect(getPriorityPremiumRequests("priority", "azure")).toBe(0);
		expect(getPriorityPremiumRequests("priority", "bedrock")).toBe(0);
	});

	it("counts priority on direct Anthropic as one premium request (fast mode)", () => {
		expect(getPriorityPremiumRequests("priority", "anthropic")).toBe(1);
	});

	it("returns zero when service tier is unset", () => {
		expect(getPriorityPremiumRequests(undefined, "openai")).toBe(0);
		expect(getPriorityPremiumRequests(null, "openai")).toBe(0);
	});

	describe("scoped tiers", () => {
		it("treats `openai-only` as priority on OpenAI and OpenAI-Codex", () => {
			expect(getPriorityPremiumRequests("openai-only", "openai")).toBe(1);
			expect(getPriorityPremiumRequests("openai-only", "openai-codex")).toBe(1);
		});

		it("treats `openai-only` as inactive on Anthropic and everywhere else", () => {
			expect(getPriorityPremiumRequests("openai-only", "anthropic")).toBe(0);
			expect(getPriorityPremiumRequests("openai-only", "github-copilot")).toBe(0);
			expect(getPriorityPremiumRequests("openai-only", "bedrock")).toBe(0);
		});

		it("treats `claude-only` as priority on direct Anthropic", () => {
			expect(getPriorityPremiumRequests("claude-only", "anthropic")).toBe(1);
		});

		it("treats `claude-only` as inactive on OpenAI, Bedrock/Vertex, and elsewhere", () => {
			expect(getPriorityPremiumRequests("claude-only", "openai")).toBe(0);
			expect(getPriorityPremiumRequests("claude-only", "openai-codex")).toBe(0);
			expect(getPriorityPremiumRequests("claude-only", "bedrock")).toBe(0);
			expect(getPriorityPremiumRequests("claude-only", "vertex")).toBe(0);
		});
	});
});

describe("resolveServiceTier", () => {
	it("passes unscoped tiers through unchanged for any provider", () => {
		expect(resolveServiceTier("flex", "openai")).toBe("flex");
		expect(resolveServiceTier("priority", "anthropic")).toBe("priority");
		expect(resolveServiceTier("auto", "openai-codex")).toBe("auto");
		expect(resolveServiceTier("default", "github-copilot")).toBe("default");
	});

	it("scopes `openai-only` to OpenAI providers", () => {
		expect(resolveServiceTier("openai-only", "openai")).toBe("priority");
		expect(resolveServiceTier("openai-only", "openai-codex")).toBe("priority");
		expect(resolveServiceTier("openai-only", "anthropic")).toBeUndefined();
		expect(resolveServiceTier("openai-only", "bedrock")).toBeUndefined();
		expect(resolveServiceTier("openai-only", undefined)).toBeUndefined();
	});

	it("scopes `claude-only` to direct Anthropic", () => {
		expect(resolveServiceTier("claude-only", "anthropic")).toBe("priority");
		expect(resolveServiceTier("claude-only", "openai")).toBeUndefined();
		expect(resolveServiceTier("claude-only", "bedrock")).toBeUndefined();
		expect(resolveServiceTier("claude-only", "vertex")).toBeUndefined();
	});

	it("returns undefined for null/undefined input", () => {
		expect(resolveServiceTier(undefined, "openai")).toBeUndefined();
		expect(resolveServiceTier(null, "openai")).toBeUndefined();
	});
});

describe("shouldSendServiceTier", () => {
	it("returns false for non-OpenAI/non-Fireworks providers", () => {
		expect(shouldSendServiceTier("flex", "azure-openai-responses")).toBe(false);
		expect(shouldSendServiceTier("scale", "firepass")).toBe(false);
		expect(shouldSendServiceTier("priority", "anthropic")).toBe(false);
	});

	it("returns true for fireworks only with the priority tier", () => {
		expect(shouldSendServiceTier("priority", "fireworks")).toBe(true);
		// Fireworks realizes only the Priority serving path — flex/scale are OpenAI-only.
		expect(shouldSendServiceTier("flex", "fireworks")).toBe(false);
		expect(shouldSendServiceTier("scale", "fireworks")).toBe(false);
		expect(shouldSendServiceTier("auto", "fireworks")).toBe(false);
		expect(shouldSendServiceTier("default", "fireworks")).toBe(false);
		expect(shouldSendServiceTier(undefined, "fireworks")).toBe(false);
	});

	it("returns true for openai with priority/flex/scale tiers", () => {
		expect(shouldSendServiceTier("priority", "openai")).toBe(true);
		expect(shouldSendServiceTier("flex", "openai")).toBe(true);
		expect(shouldSendServiceTier("scale", "openai")).toBe(true);
	});

	it("returns true for openai-codex with priority/flex/scale tiers", () => {
		expect(shouldSendServiceTier("priority", "openai-codex")).toBe(true);
		expect(shouldSendServiceTier("flex", "openai-codex")).toBe(true);
		expect(shouldSendServiceTier("scale", "openai-codex")).toBe(true);
	});

	it("returns false for default tier on OpenAI providers", () => {
		expect(shouldSendServiceTier("default", "openai")).toBe(false);
		expect(shouldSendServiceTier("default", "openai-codex")).toBe(false);
	});

	it("returns false for auto tier on OpenAI providers", () => {
		expect(shouldSendServiceTier("auto", "openai")).toBe(false);
		expect(shouldSendServiceTier("auto", "openai-codex")).toBe(false);
	});

	it("returns false for undefined/null tier", () => {
		expect(shouldSendServiceTier(undefined, "openai")).toBe(false);
		expect(shouldSendServiceTier(null, "openai")).toBe(false);
	});
});
