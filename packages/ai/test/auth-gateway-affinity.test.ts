import { describe, expect, it } from "bun:test";
import type { AffinityCandidate, AffinityLevel, StatePortability } from "@oh-my-pi/pi-ai/auth-gateway/affinity";
import { candidateAllowed } from "@oh-my-pi/pi-ai/auth-gateway/affinity";

const openai: AffinityCandidate = { id: "openai-1", provider: "openai", accountId: "acct-oai", deployment: "dep-oai" };
const anthropic: AffinityCandidate = {
	id: "anthropic-1",
	provider: "anthropic",
	accountId: "acct-ant",
	deployment: "dep-ant",
};

function portability(scope: StatePortability["scope"], origin?: string): StatePortability {
	if (origin === undefined) {
		return { scope };
	}
	return { scope, origin };
}

describe("candidateAllowed", () => {
	it("allows any candidate when portability is absent", () => {
		expect(candidateAllowed(undefined, openai, "required")).toBe(true);
		expect(candidateAllowed(undefined, anthropic, "none")).toBe(true);
	});

	it("allows any candidate when level is none", () => {
		const requiredProvider = portability("provider", "anthropic");
		expect(candidateAllowed(requiredProvider, openai, "none")).toBe(true);
	});

	it("allows any candidate when scope is portable", () => {
		const portable: StatePortability = { scope: "portable", origin: "anthropic" };
		expect(candidateAllowed(portable, openai, "required")).toBe(true);
		expect(candidateAllowed(portable, anthropic, "required")).toBe(true);
		expect(candidateAllowed({ scope: "portable" }, openai, "required")).toBe(true);
	});

	it("allows a required-mismatch when level is preferred", () => {
		expect(candidateAllowed(portability("provider", "anthropic"), openai, "preferred")).toBe(true);
		expect(candidateAllowed(portability("account", "acct-ant"), openai, "preferred")).toBe(true);
		expect(candidateAllowed(portability("deployment", "dep-ant"), openai, "preferred")).toBe(true);
	});

	it("rejects an openai candidate when required provider origin is anthropic (negative)", () => {
		expect(candidateAllowed(portability("provider", "anthropic"), openai, "required")).toBe(false);
	});

	it("allows an anthropic candidate when required provider origin is anthropic", () => {
		expect(candidateAllowed(portability("provider", "anthropic"), anthropic, "required")).toBe(true);
	});

	it("rejects required account mismatch and allows a match (negative)", () => {
		expect(candidateAllowed(portability("account", "acct-ant"), openai, "required")).toBe(false);
		expect(candidateAllowed(portability("account", "acct-ant"), anthropic, "required")).toBe(true);
	});

	it("rejects required deployment mismatch and allows a match (negative)", () => {
		expect(candidateAllowed(portability("deployment", "dep-ant"), openai, "required")).toBe(false);
		expect(candidateAllowed(portability("deployment", "dep-ant"), anthropic, "required")).toBe(true);
	});

	it("rejects required non-portable when origin is missing (negative)", () => {
		const level: AffinityLevel = "required";
		expect(candidateAllowed(portability("provider"), openai, level)).toBe(false);
		expect(candidateAllowed(portability("account"), openai, level)).toBe(false);
		expect(candidateAllowed(portability("deployment"), openai, level)).toBe(false);
	});

	it("allows preferred non-portable even when origin is missing", () => {
		expect(candidateAllowed(portability("provider"), openai, "preferred")).toBe(true);
	});

	it("rejects required provider when the candidate omits provider (negative)", () => {
		const bare: AffinityCandidate = { id: "bare" };
		expect(candidateAllowed(portability("provider", "anthropic"), bare, "required")).toBe(false);
	});
});
