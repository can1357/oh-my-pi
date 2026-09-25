import { describe, expect, it } from "bun:test";
import type { RouteSurfaceEligibility } from "@oh-my-pi/pi-ai/auth-gateway/route-surface";
import { surfaceAllowsApi } from "@oh-my-pi/pi-ai/auth-gateway/route-surface";

describe("surfaceAllowsApi", () => {
	it("allows openai-chat for completions, chat, grok chat-ish, and openai-compatible", () => {
		expect(surfaceAllowsApi("openai-chat", "openai-completions")).toBe(true);
		expect(surfaceAllowsApi("openai-chat", "custom-openai-completions")).toBe(true);
		expect(surfaceAllowsApi("openai-chat", "openai-chat")).toBe(true);
		expect(surfaceAllowsApi("openai-chat", "grok")).toBe(true);
		expect(surfaceAllowsApi("openai-chat", "grok-chat")).toBe(true);
		expect(surfaceAllowsApi("openai-chat", "openai-compatible")).toBe(true);
	});

	it("rejects openai-chat for unrelated and grok-responses apis (negative)", () => {
		expect(surfaceAllowsApi("openai-chat", "openai-responses")).toBe(false);
		expect(surfaceAllowsApi("openai-chat", "anthropic-messages")).toBe(false);
		expect(surfaceAllowsApi("openai-chat", "google-generative-ai")).toBe(false);
		expect(surfaceAllowsApi("openai-chat", "ollama-chat")).toBe(false);
		expect(surfaceAllowsApi("openai-chat", "grok-responses")).toBe(false);
	});

	it("allows openai-responses when api includes responses", () => {
		expect(surfaceAllowsApi("openai-responses", "openai-responses")).toBe(true);
		expect(surfaceAllowsApi("openai-responses", "openai-codex-responses")).toBe(true);
		expect(surfaceAllowsApi("openai-responses", "azure-openai-responses")).toBe(true);
		expect(surfaceAllowsApi("openai-responses", "grok-responses")).toBe(true);
	});

	it("rejects openai-responses when api has no responses token (negative)", () => {
		expect(surfaceAllowsApi("openai-responses", "openai-completions")).toBe(false);
		expect(surfaceAllowsApi("openai-responses", "openai-chat")).toBe(false);
		expect(surfaceAllowsApi("openai-responses", "grok-chat")).toBe(false);
	});

	it("allows anthropic-messages when api includes anthropic", () => {
		expect(surfaceAllowsApi("anthropic-messages", "anthropic-messages")).toBe(true);
		expect(surfaceAllowsApi("anthropic-messages", "custom-anthropic")).toBe(true);
	});

	it("rejects anthropic-messages vs google-generative-ai (negative)", () => {
		const pairing: RouteSurfaceEligibility = {
			surface: "anthropic-messages",
			modelApi: "google-generative-ai",
		};
		expect(surfaceAllowsApi(pairing.surface, pairing.modelApi)).toBe(false);
	});

	it("allows gemini-v1beta for google-generative-ai and google-vertex", () => {
		expect(surfaceAllowsApi("gemini-v1beta", "google-generative-ai")).toBe(true);
		expect(surfaceAllowsApi("gemini-v1beta", "google-vertex")).toBe(true);
	});

	it("rejects gemini-v1beta for google-gemini-cli and other apis (negative)", () => {
		expect(surfaceAllowsApi("gemini-v1beta", "google-gemini-cli")).toBe(false);
		expect(surfaceAllowsApi("gemini-v1beta", "openai-completions")).toBe(false);
		expect(surfaceAllowsApi("gemini-v1beta", "anthropic-messages")).toBe(false);
	});

	it("allows pi-native for any api", () => {
		expect(surfaceAllowsApi("pi-native", "openai-completions")).toBe(true);
		expect(surfaceAllowsApi("pi-native", "google-generative-ai")).toBe(true);
		expect(surfaceAllowsApi("pi-native", "anthropic-messages")).toBe(true);
		expect(surfaceAllowsApi("pi-native", "unknown-custom-api")).toBe(true);
		expect(surfaceAllowsApi("pi-native", "")).toBe(true);
	});

	it("rejects unknown surface/api pairings (negative)", () => {
		expect(surfaceAllowsApi("openai-chat", "bedrock-converse-stream")).toBe(false);
		expect(surfaceAllowsApi("openai-responses", "google-vertex")).toBe(false);
		expect(surfaceAllowsApi("gemini-v1beta", "openai-responses")).toBe(false);
		expect(surfaceAllowsApi("anthropic-messages", "openai-completions")).toBe(false);
	});
});
