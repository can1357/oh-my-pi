import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { Tool } from "../src/types";
import { type CapturedRequest, captureFetch, factoryModel, responsesChunks, workosJwt } from "./helpers/factory-droid";

/**
 * Responses-wire request facts the native parity projection cannot see: the
 * OpenAI-Platform header, session-derived identifiers and caller overrides.
 */

const readTool: Tool = {
	name: "Read",
	description: "Read a file",
	parameters: type({ path: "string" }),
};

/** Credential carrying the WorkOS user id (`sub`) and org claims. */
const WORKOS_TOKEN_WITH_USER = workosJwt({ sub: "user_123", external_org_id: "org-1" });

function context() {
	return {
		systemPrompt: ["OMP prompt"],
		messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
		tools: [readTool],
	};
}

async function capture(id: string, options: Parameters<typeof streamFactoryDroid>[2] = {}, upstream?: string) {
	const captured: CapturedRequest[] = [];
	await streamFactoryDroid(factoryModel(id, upstream ? [upstream] : undefined), context(), {
		apiKey: WORKOS_TOKEN_WITH_USER,
		fetch: captureFetch(captured, responsesChunks("GPT_OK")),
		sessionId: "sess-1",
		reasoning: Effort.Medium,
		...options,
	}).result();
	return captured[0];
}

describe("Factory Droid responses wire", () => {
	it.each([
		["gpt-5.2", "openai", "org-bHuLtG1fGmYk5YaOihAAXFBw"],
		["gpt-5.6-sol", "azure_openai", "org-bHuLtG1fGmYk5YaOihAAXFBw"],
		["gpt-5.6-terra", "bedrock_openai", undefined],
		["grok-4.7", "xai", undefined],
	] as const)("%s via %s sends OpenAI-Platform %s", async (id, upstream, platform) => {
		const request = await capture(id, {}, upstream);
		expect(request.headers["x-api-provider"]).toBe(upstream);
		expect(request.headers["openai-platform"] as string | undefined).toBe(platform);
	});

	it("derives safety_identifier from the session, never the token's user or org claims", async () => {
		const request = await capture("gpt-5.6-sol", {}, "openai");
		// Native computes userId ?? sessionId but never passes userId — the wire value is the session id,
		// deterministically mapped to a v4-shaped uuid (shape pinned; exact bytes are algorithm-internal).
		expect(request.body.safety_identifier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(request.body.safety_identifier).toBe(request.body.prompt_cache_key);
	});

	it("an explicit caller toolChoice is forwarded as-is", async () => {
		const request = await capture("gpt-5.2", { toolChoice: "none" });
		expect(request.body.tool_choice).toBe("none");
	});

	it("never forwards caller temperature on this wire", async () => {
		const request = await capture("gpt-5.2", { temperature: 0.3 });
		expect(request.body.temperature).toBeUndefined();
	});
});
