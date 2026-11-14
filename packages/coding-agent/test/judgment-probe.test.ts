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
		const { fetch } = respond(() => answered("jev-2026-11"));
		const result = await probeNativeJudgeRoute(model, { apiKey: "key", fetch });
		expect(result).toMatchObject({ ok: true, expectedModel: "jev-test", servedModel: "jev-2026-11" });
		expect(formatNativeJudgeProbe("fixture/jev-test", result)).toMatch(
			/passed in \d+ ms · served by jev-2026-11 \(requested jev-test\)$/,
		);
	});

	test.each([
		["a refused key", () => new Response("unauthorized", { status: 401 }), "credential", "API key was refused"],
		[
			"an unknown root or model",
			() => new Response("not found", { status: 404 }),
			"not-found",
			"does not serve jev-test",
		],
		["a foreign envelope", () => Response.json({ choices: [] }), "protocol", "not a typesafe judgment response"],
	])("%s fails with its class", async (_name, response, failure, message) => {
		const { fetch, calls } = respond(response);
		const result = await probeNativeJudgeRoute(model, { apiKey: "key", fetch });
		expect(calls).toHaveLength(1);
		expect(result).toMatchObject({ ok: false, failure });
		expect(formatNativeJudgeProbe("fixture/jev-test", result)).toContain(message);
	});
});
