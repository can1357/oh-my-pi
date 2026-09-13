/**
 * Fire Pass (Fireworks subscription) wiring.
 *
 * Fire Pass keys (`fpk_…`) authorize only router endpoints (e.g. `accounts/fireworks/routers/glm-5p2-fast`)
 * and reject `/v1/models`. The bundled catalog stores friendly public ids (`glm-5.2-fast`, `kimi-k3-fast`)
 * and the openai-completions provider translates them to router wire form at request time.
 */
import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Fire Pass provider", () => {
	it("ships bundled GLM 5.2 Fast and Kimi K3 Fast entries on the firepass provider", () => {
		const glm = getBundledModel("firepass", "glm-5.2-fast");
		expect(glm).toBeDefined();
		expect(glm?.provider).toBe("firepass");
		expect(glm?.contextWindow).toBe(1048576);
		expect(glm?.reasoning).toBe(true);

		const kimi = getBundledModel("firepass", "kimi-k3-fast");
		expect(kimi).toBeDefined();
		expect(kimi?.provider).toBe("firepass");
		expect(kimi?.contextWindow).toBe(1048576);
		expect(kimi?.reasoning).toBe(true);
	});

	it("translates glm-5.2-fast and kimi-k3-fast to router wire endpoints", async () => {
		const glm = getBundledModel<"openai-completions">("firepass", "glm-5.2-fast");
		const kimi = getBundledModel<"openai-completions">("firepass", "kimi-k3-fast");

		const bodies: string[] = [];
		const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			if (typeof init?.body === "string") bodies.push(init.body);
			return sseResponse([
				{ choices: [{ delta: { content: "ok" }, index: 0 }] },
				{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
				"[DONE]",
			]);
		};

		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};

		for await (const _ of streamOpenAICompletions(glm as Model<"openai-completions">, context, {
			apiKey: "fpk_test",
			fetch: fetchMock,
		})) {
		}

		for await (const _ of streamOpenAICompletions(kimi as Model<"openai-completions">, context, {
			apiKey: "fpk_test",
			fetch: fetchMock,
		})) {
		}

		expect(bodies.length).toBe(2);
		expect(JSON.parse(bodies[0] ?? "{}").model).toBe("accounts/fireworks/routers/glm-5p2-fast");
		expect(JSON.parse(bodies[1] ?? "{}").model).toBe("accounts/fireworks/routers/kimi-k3-fast");
	});

	it("validates login against accounts/fireworks/routers/glm-5p2-fast", async () => {
		const login = getProviderDefinition("firepass")?.login;
		expect(login).toBeDefined();

		let capturedBody: string | null = null;
		const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = typeof init?.body === "string" ? init.body : null;
			return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const ctrl: OAuthController = {
			fetch: fetchMock,
			onPrompt: async () => "fpk_test",
			onAuth: () => {},
			onProgress: () => {},
		};

		const result = await login!(ctrl);
		expect(result).toBe("fpk_test");
		expect(capturedBody).not.toBeNull();
		expect(JSON.parse(capturedBody ?? "{}").model).toBe("accounts/fireworks/routers/glm-5p2-fast");
	});
});
