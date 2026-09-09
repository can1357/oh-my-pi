import { describe, expect, it } from "bun:test";
import { loginXiaomi } from "@oh-my-pi/pi-ai/registry/oauth/xiaomi";
import { xiaomiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import modelsJson from "../src/models.json";

const TOKEN_PLAN_SGP_HOST = "token-plan-sgp.xiaomimimo.com";
const STANDARD_HOST = "api.xiaomimimo.com";

describe("issue-772: Xiaomi MiMo token-plan (tp-) keys", () => {
	it("loginXiaomi validates tp- keys against the SGP token-plan host first", async () => {
		const seen: string[] = [];
		const fetchMock: FetchImpl = async input => {
			seen.push(String(input));
			return new Response("{}", { status: 200 });
		};

		await loginXiaomi({
			onAuth: () => {},
			onPrompt: async () => "tp-test-key",
			onProgress: () => {},
			fetch: fetchMock,
		});

		expect(seen).toHaveLength(1);
		const url = seen[0]!;
		expect(url).toContain(TOKEN_PLAN_SGP_HOST);
		expect(url).toContain("/chat/completions");
	});

	it("xiaomiModelManagerOptions discovers models from the SGP token-plan host when given a tp- key", async () => {
		const seen: string[] = [];
		const fetchMock: FetchImpl = async input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const opts = xiaomiModelManagerOptions({ apiKey: "tp-test-key", fetch: fetchMock });
		await opts.fetchDynamicModels?.();

		expect(seen.length).toBeGreaterThan(0);
		const url = seen[0]!;
		expect(url).toContain(TOKEN_PLAN_SGP_HOST);
		expect(url).toContain("/v1/models");
	});

	it("xiaomiModelManagerOptions still uses the standard host for sk- keys", async () => {
		const seen: string[] = [];
		const fetchMock: FetchImpl = async input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const opts = xiaomiModelManagerOptions({ apiKey: "sk-test-key", fetch: fetchMock });
		await opts.fetchDynamicModels?.();

		expect(seen.length).toBeGreaterThan(0);
		const url = seen[0]!;
		expect(url).toContain(STANDARD_HOST);
		expect(url).not.toContain(TOKEN_PLAN_SGP_HOST);
	});

	it("filters Xiaomi ASR and TTS-only models from discovery", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "mimo-v2.5-asr", name: "mimo-v2.5-asr" },
						{ id: "mimo-v2.5-tts", name: "mimo-v2.5-tts" },
						{ id: "mimo-v2.5", name: "MiMo-V2.5" },
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);

		const models = await xiaomiModelManagerOptions({
			apiKey: "sk-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["mimo-v2.5"]);
	});

	it("does not bundle Xiaomi ASR-only models", () => {
		expect(Object.keys(modelsJson.xiaomi)).not.toContain("mimo-v2.5-asr");
	});
});
