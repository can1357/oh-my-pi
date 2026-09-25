import { describe, expect, it } from "bun:test";
import { capabilitiesFor, fitsRequest, routeCapabilities } from "@oh-my-pi/pi-ai/auth-gateway/capabilities";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, Model } from "../src/types";

interface FakeModelOverrides {
	api?: Api;
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

function fakeModel(id: string, overrides: FakeModelOverrides = {}): Model<Api> {
	return buildModel({
		api: overrides.api ?? "openai-completions",
		name: id,
		id,
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: overrides.reasoning ?? false,
		contextWindow: 128000,
		maxTokens: 8192,
		input: overrides.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

describe("capabilitiesFor", () => {
	it("sets text, tools, and parallelTools true by default", () => {
		const caps = capabilitiesFor(fakeModel("text-only"));
		expect(caps.text).toBe(true);
		expect(caps.tools).toBe(true);
		expect(caps.parallelTools).toBe(true);
		expect(caps.vision).toBe(false);
		expect(caps.reasoning).toBe(false);
	});

	it("sets vision when input includes image", () => {
		const caps = capabilitiesFor(fakeModel("vision", { input: ["text", "image"] }));
		expect(caps.vision).toBe(true);
	});

	it("copies reasoning from the model", () => {
		expect(capabilitiesFor(fakeModel("r", { reasoning: true })).reasoning).toBe(true);
		expect(capabilitiesFor(fakeModel("n", { reasoning: false })).reasoning).toBe(false);
	});

	it("flags responsesApi from api id", () => {
		expect(capabilitiesFor(fakeModel("resp", { api: "openai-responses" })).responsesApi).toBe(true);
		expect(capabilitiesFor(fakeModel("codex", { api: "openai-codex-responses" })).responsesApi).toBe(true);
		expect(capabilitiesFor(fakeModel("azure", { api: "azure-openai-responses" })).responsesApi).toBe(true);
		expect(capabilitiesFor(fakeModel("chat")).responsesApi).toBe(false);
	});

	it("flags messagesApi when api includes anthropic", () => {
		expect(capabilitiesFor(fakeModel("claude", { api: "anthropic-messages" })).messagesApi).toBe(true);
		expect(capabilitiesFor(fakeModel("chat")).messagesApi).toBe(false);
	});
});

describe("routeCapabilities", () => {
	it("returns all-false guaranteed and conditional for an empty list (negative empty-AND)", () => {
		const route = routeCapabilities([]);
		expect(route.guaranteed.text).toBe(false);
		expect(route.guaranteed.vision).toBe(false);
		expect(route.guaranteed.tools).toBe(false);
		expect(route.guaranteed.parallelTools).toBe(false);
		expect(route.guaranteed.reasoning).toBe(false);
		expect(route.guaranteed.responsesApi).toBe(false);
		expect(route.guaranteed.messagesApi).toBe(false);
		expect(route.conditional.text).toBe(false);
		expect(route.conditional.vision).toBe(false);
		expect(route.conditional.tools).toBe(false);
		expect(route.conditional.parallelTools).toBe(false);
		expect(route.conditional.reasoning).toBe(false);
		expect(route.conditional.responsesApi).toBe(false);
		expect(route.conditional.messagesApi).toBe(false);
	});

	it("AND vision across mixed targets is conditional not guaranteed", () => {
		const vision = capabilitiesFor(fakeModel("vision", { input: ["text", "image"] }));
		const textOnly = capabilitiesFor(fakeModel("text"));
		const route = routeCapabilities([vision, textOnly]);
		expect(route.guaranteed.vision).toBe(false);
		expect(route.conditional.vision).toBe(true);
		expect(route.guaranteed.text).toBe(true);
		expect(route.conditional.text).toBe(false);
	});

	it("does not mark a unanimous capability as conditional (negative)", () => {
		const a = capabilitiesFor(fakeModel("a", { input: ["text", "image"] }));
		const b = capabilitiesFor(fakeModel("b", { input: ["text", "image"] }));
		const route = routeCapabilities([a, b]);
		expect(route.guaranteed.vision).toBe(true);
		expect(route.conditional.vision).toBe(false);
	});
});

describe("fitsRequest", () => {
	it("rejects a vision need against a text-only model (negative)", () => {
		const textOnly = capabilitiesFor(fakeModel("text"));
		expect(fitsRequest(textOnly, { vision: true })).toBe(false);
	});

	it("accepts a vision-capable model for a vision need", () => {
		const vision = capabilitiesFor(fakeModel("vision", { input: ["text", "image"] }));
		expect(fitsRequest(vision, { vision: true })).toBe(true);
	});

	it("ignores absent need flags", () => {
		const textOnly = capabilitiesFor(fakeModel("text"));
		expect(fitsRequest(textOnly, {})).toBe(true);
		expect(fitsRequest(textOnly, { vision: false, tools: false, reasoning: false })).toBe(true);
	});

	it("rejects a reasoning need when the model has no reasoning (negative)", () => {
		const textOnly = capabilitiesFor(fakeModel("text"));
		expect(fitsRequest(textOnly, { reasoning: true })).toBe(false);
	});
});
