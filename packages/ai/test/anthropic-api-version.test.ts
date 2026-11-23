import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

// API version 2026-10-21 returns a 400 for `temperature`, `top_p`, or `top_k`
// on every model, so the version header and the sampling fields must flip
// together. PI_ANTHROPIC_API_VERSION opts in the official API only.

const SPEC = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} as const;

const OFFICIAL: Model<"anthropic-messages"> = buildModel({ ...SPEC, input: [...SPEC.input] });
const THIRD_PARTY: Model<"anthropic-messages"> = buildModel({
	...SPEC,
	input: [...SPEC.input],
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
});

interface Captured {
	version: string | null;
	body: { temperature?: number; top_p?: number; top_k?: number };
}

async function capture(model: Model<"anthropic-messages">, apiKey: string): Promise<Captured> {
	let captured: Captured | undefined;
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		captured = {
			version: new Headers(init?.headers).get("anthropic-version"),
			body: JSON.parse(requestBodyText(init) ?? "{}"),
		};
		return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	await streamAnthropic(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
		{ apiKey, thinkingEnabled: false, temperature: 0.2, topP: 0.3, topK: 4, fetch: fetchMock },
	).result();
	if (!captured) throw new Error("request was not sent");
	return captured;
}

describe("anthropic API version", () => {
	withOfficialAnthropicEndpoint();

	it("keeps 2023-06-01 and sampling params by default", async () => {
		await withEnv({ PI_ANTHROPIC_API_VERSION: undefined }, async () => {
			const { version, body } = await capture(OFFICIAL, "sk-ant-api-test");
			expect(version).toBe("2023-06-01");
			expect(body).toMatchObject({ temperature: 0.2, top_p: 0.3, top_k: 4 });
		});
	});

	it("sends 2026-10-21 and drops sampling params on the official API for API-key and OAuth", async () => {
		await withEnv({ PI_ANTHROPIC_API_VERSION: "2026-10-21" }, async () => {
			for (const apiKey of ["sk-ant-api-test", "sk-ant-oat-test"]) {
				const { version, body } = await capture(OFFICIAL, apiKey);
				expect(version).toBe("2026-10-21");
				expect(body.temperature).toBeUndefined();
				expect(body.top_p).toBeUndefined();
				expect(body.top_k).toBeUndefined();
			}
		});
	});

	it("leaves non-official Anthropic-compatible endpoints on 2023-06-01", async () => {
		await withEnv({ PI_ANTHROPIC_API_VERSION: "2026-10-21" }, async () => {
			const { version, body } = await capture(THIRD_PARTY, "sk-third-party");
			expect(version).toBe("2023-06-01");
			expect(body.temperature).toBe(0.2);
		});
	});

	it("falls back to 2023-06-01 for an unknown version", async () => {
		await withEnv({ PI_ANTHROPIC_API_VERSION: "2030-01-01" }, async () => {
			const { version, body } = await capture(OFFICIAL, "sk-ant-api-test");
			expect(version).toBe("2023-06-01");
			expect(body.temperature).toBe(0.2);
		});
	});
});
