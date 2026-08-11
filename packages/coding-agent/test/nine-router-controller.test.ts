/**
 * Tests for the 9router controller.
 */

import { describe, expect, test } from "bun:test";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai";
import { applyNineRouterRouting, NineRouterController } from "../src/config/nine-router-controller";
import { Settings } from "../src/config/settings";

function makeFetch(mockIds: string[]): FetchImpl {
	return async (input, _init) => {
		const url = String(input);
		if (url.endsWith("/models")) {
			return Response.json({ data: mockIds.map(id => ({ id })) });
		}
		if (url.endsWith("/chat/completions")) {
			return new Response(null, { status: 200 });
		}
		return new Response("Not found", { status: 404 });
	};
}

function makeSettings(): Settings {
	return Settings.isolated();
}

describe("NineRouterController", () => {
	test("applies first available candidate per role", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch(["ompk", "fast-fallback", "openrouter-free-fallback"]),
		});

		const result = await controller.apply();

		expect(result.errors).toEqual([]);
		expect(settings.getModelRole("default")).toBe("9router/ompk");
		expect(settings.getModelRole("smol")).toBe("9router/fast-fallback");
		expect(settings.getModelRole("free")).toBe("9router/openrouter-free-fallback");
	});

	test("falls back to cheap and free when subscription combos are missing", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch(["deepseek-v4-flash-fallback", "openrouter-free-fallback", "free-fast-rr"]),
		});

		await controller.apply();

		expect(settings.getModelRole("default")).toBe("9router/deepseek-v4-flash-fallback");
		expect(settings.getModelRole("smol")).toBe("9router/free-fast-rr");
		expect(settings.getModelRole("free")).toBe("9router/openrouter-free-fallback");
	});

	test("routes 9router Antigravity and Gemini CLI models", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch(["ag/claude-sonnet-4-6", "openrouter/qwen3-32b:nitro", "gemini-3.1-flash-lite"]),
		});

		await controller.apply();

		expect(settings.getModelRole("default")).toBe("9router/ag/claude-sonnet-4-6");
		expect(settings.getModelRole("balanced")).toBe("9router/openrouter/qwen3-32b:nitro");
		expect(settings.getModelRole("smol")).toBe("9router/gemini-3.1-flash-lite");
		expect(settings.getModelRole("vision")).toBeUndefined();
		expect(settings.getModelRole("task")).toBe("9router/openrouter/qwen3-32b:nitro");
	});

	test("routes OpenRouter nitro fallbacks from 9router", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch(["openai/gpt-oss-120b:nitro"]),
		});

		await controller.apply();

		expect(settings.getModelRole("balanced")).toBe("9router/openai/gpt-oss-120b:nitro");
		expect(settings.getModelRole("task")).toBe("9router/openai/gpt-oss-120b:nitro");
	});

	test("routes Qwen 3.6 nitro from 9router", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch(["openrouter/qwen/qwen3.6-35b-a3b:nitro"]),
		});

		await controller.apply();

		expect(settings.getModelRole("balanced")).toBe("9router/openrouter/qwen/qwen3.6-35b-a3b:nitro");
		expect(settings.getModelRole("task")).toBe("9router/openrouter/qwen/qwen3.6-35b-a3b:nitro");
	});

	test("routes the optional ClinePass subscription combo", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch(["clinepass-deepseek-v4-flash"]),
		});

		await controller.apply({ roles: ["default", "balanced", "task", "budget"] });

		expect(settings.getModelRole("default")).toBe("9router/clinepass-deepseek-v4-flash");
		expect(settings.getModelRole("balanced")).toBe("9router/clinepass-deepseek-v4-flash");
		expect(settings.getModelRole("task")).toBe("9router/clinepass-deepseek-v4-flash");
		expect(settings.getModelRole("budget")).toBe("9router/clinepass-deepseek-v4-flash");
	});

	test("probe mode skips candidates that fail the chat probe", async () => {
		const settings = makeSettings();
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/models")) {
				return Response.json({ data: [{ id: "ompk" }, { id: "fast-fallback" }] });
			}
			if (url.endsWith("/chat/completions")) {
				const body = (init?.body ? JSON.parse(String(init.body)) : {}) as { model?: string };
				if (body.model === "ompk") {
					return new Response(null, { status: 500 });
				}
				return new Response(null, { status: 200 });
			}
			return new Response("Not found", { status: 404 });
		};

		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: fetchImpl,
		});

		const result = await controller.apply({ mode: "probe" });

		const defaultRoute = result.routes.find(r => r.role === "default");
		expect(defaultRoute?.selected).toBe("fast-fallback");
		expect(defaultRoute?.probed).toContain("ompk");
		expect(defaultRoute?.probed).toContain("fast-fallback");
		expect(settings.getModelRole("default")).toBe("9router/fast-fallback");
	});

	test("normalizes provider-looking combo ids through 9router", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch([
				"openrouter/qwen3-32b:nitro",
				"ag/gemini-3-flash",
				"gc/gemini-3-flash-preview",
				"openai/gpt-oss-120b:nitro",
			]),
			slots: [
				{ role: "balanced", candidates: ["9router/openrouter/qwen3-32b:nitro"] },
				{ role: "smol", candidates: ["ag/gemini-3-flash"] },
				{ role: "vision", candidates: ["gc/gemini-3-flash-preview"] },
				{ role: "task", candidates: ["9router/openai/gpt-oss-120b:nitro"] },
			],
		});

		expect(controller.getCandidates("balanced")).toEqual(["openrouter/qwen3-32b:nitro"]);
		expect(controller.getCandidates("task")).toEqual(["openai/gpt-oss-120b:nitro"]);

		await controller.apply({ roles: ["balanced", "smol", "vision", "task"] });

		expect(settings.getModelRole("balanced")).toBe("9router/openrouter/qwen3-32b:nitro");
		expect(settings.getModelRole("smol")).toBe("9router/ag/gemini-3-flash");
		expect(settings.getModelRole("vision")).toBe("9router/gc/gemini-3-flash-preview");
		expect(settings.getModelRole("task")).toBe("9router/openai/gpt-oss-120b:nitro");
	});

	test("leaves role unset when no candidates are available", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch([]),
		});

		await controller.apply({ roles: ["default"] });

		expect(settings.getModelRole("default")).toBeUndefined();
	});

	test("applyNineRouterRouting convenience helper sets roles", async () => {
		const settings = makeSettings();
		await applyNineRouterRouting(settings, {
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: makeFetch(["ompk"]),
			roles: ["default"],
		});

		expect(settings.getModelRole("default")).toBe("9router/ompk");
	});

	test("reports errors when 9router is unreachable", async () => {
		const settings = makeSettings();
		const controller = new NineRouterController({
			settings,
			baseUrl: "http://127.0.0.1:20128/v1",
			fetch: async () => {
				throw new Error("connection refused");
			},
		});

		const result = await controller.apply({ roles: ["default"] });

		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("connection refused");
		expect(settings.getModelRole("default")).toBeUndefined();
	});
});
