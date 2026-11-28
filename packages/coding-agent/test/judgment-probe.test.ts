import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { formatNativeJudgeProbe, probeNativeJudgeRoute } from "@oh-my-pi/pi-coding-agent/judgment/probe";

const model = buildModel({
	id: "jev-test",
	name: "jev-test",
	api: "typesafe",
	provider: "fixture",
	baseUrl: "https://judge.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 1024,
});

function respond(response: () => Response): { fetch: FetchImpl; calls: string[] } {
	const calls: string[] = [];
	const fetch = (async (input: string | URL | Request) => {
		calls.push(String(input));
		return response();
	}) as FetchImpl;
	return { fetch, calls };
}

const answered = (served: string) =>
	Response.json({
		model: served,
		answers: { route_test: { type: "noul", noul: 0.97 } },
		usage: { input_tokens: 12, output_tokens: 1 },
	});

describe("probeNativeJudgeRoute", () => {
	test("a judgment from the requested model passes", async () => {
		const { fetch, calls } = respond(() => answered("jev-test"));
		const result = await probeNativeJudgeRoute(model, { apiKey: "key", fetch });
		expect(calls).toEqual(["https://judge.example/v1/systemone"]);
		expect(result).toMatchObject({ ok: true, expectedModel: "jev-test", servedModel: "jev-test" });
		expect(result.ok && result.usage.input).toBe(12);
		expect(formatNativeJudgeProbe("fixture/jev-test", result)).toMatch(
			/^Test of fixture\/jev-test passed in \d+ ms$/,
		);
	});

	test("a different served model is reported, not failed", async () => {
		const { fetch } = respond(() => answered("jev-1.14"));
		const result = await probeNativeJudgeRoute(model, { apiKey: "key", fetch });
		expect(result).toMatchObject({ ok: true, expectedModel: "jev-test", servedModel: "jev-1.14" });
		expect(formatNativeJudgeProbe("fixture/jev-test", result)).toMatch(
			/passed in \d+ ms · served by jev-1\.14 \(requested jev-test\)$/,
		);
	});

	// Bifrost's governance refusals: the decision as the top-level `type`, its reason as `error.message`.
	const bifrost = (status: number, type: string, message: string) => () =>
		Response.json({ type, status_code: status, error: { message } }, { status });

	test.each([
		[
			"a refused key",
			() => new Response("unauthorized", { status: 401 }),
			{ failure: "credential", status: 401 },
			["unauthorized"],
		],
		[
			"a model the key may not use",
			bifrost(403, "model_blocked", "Model 'fixture/other-model' is not allowed for virtual key 'vk-test'"),
			{ failure: "model-refused", status: 403 },
			["jev-test", "Model 'fixture/other-model' is not allowed for virtual key 'vk-test'"],
		],
		[
			"a model refusal only the top-level type names",
			bifrost(
				403,
				"model_blocked",
				"Passthrough on provider 'fixture' requires a model: this access restricts models, and the request names none that can be checked",
			),
			{ failure: "model-refused", status: 403 },
			["jev-test", "this access restricts models"],
		],
		[
			"a 403 refusing the key itself",
			bifrost(403, "access_blocked", "virtual key has expired"),
			{ failure: "credential", status: 403 },
			["virtual key has expired"],
		],
		[
			"a 403 naming what the key may not reach, not the model",
			bifrost(403, "provider_blocked", "Provider 'fixture' is not allowed for virtual key 'vk-test'"),
			{ failure: "forbidden", status: 403 },
			["jev-test", "Provider 'fixture' is not allowed for virtual key 'vk-test'"],
		],
		[
			"a 403 refusing the provider for a key whose name says model",
			bifrost(403, "provider_blocked", "Provider 'openai' is not allowed for virtual key 'judge-models'"),
			{ failure: "forbidden", status: 403 },
			["jev-test", "Provider 'openai' is not allowed for virtual key 'judge-models'"],
		],
		[
			"a 403 refusing a project whose name says model",
			bifrost(
				403,
				"access_blocked",
				'project "ml-models" not found. It does not exist or does not admit this request.',
			),
			{ failure: "forbidden", status: 403 },
			["jev-test", 'project "ml-models" not found'],
		],
		[
			"a key refusal in a JSON body without an error envelope",
			() => Response.json({ detail: "Not authenticated" }, { status: 403 }),
			{ failure: "credential", status: 403 },
			["Not authenticated"],
		],
		[
			"a 403 whose body names neither",
			() => new Response("forbidden", { status: 403 }),
			{ failure: "forbidden", status: 403 },
			["jev-test"],
		],
		[
			"an unknown root or model",
			() => new Response("not found", { status: 404 }),
			{ failure: "not-found", status: 404 },
			["jev-test"],
		],
		["a foreign envelope", () => Response.json({ choices: [] }), { failure: "protocol" }, ["typesafe"]],
	])("%s fails with its class", async (_name, response, outcome, mentions) => {
		const { fetch, calls } = respond(response);
		const result = await probeNativeJudgeRoute(model, { apiKey: "key", fetch });
		expect(calls).toHaveLength(1);
		expect(result).toMatchObject({ ok: false, ...outcome });
		// A route label without the wire id, so a "jev-test" mention can only come from the failure message.
		const line = formatNativeJudgeProbe("fixture/judge", result);
		for (const mention of mentions) expect(line).toContain(mention);
	});
});
