import { describe, expect, test } from "bun:test";
import { shouldEnableAppendOnlyContext } from "@oh-my-pi/pi-coding-agent/config/append-only-context-mode";

const XIAOMI_TOKEN_PLAN_ANTHROPIC = {
	provider: "xiaomi-token-plan-sgp",
	baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
};

const GENERIC_PROXY = {
	provider: "generic-proxy",
	baseUrl: "https://llm.example.com/v1",
};

describe("shouldEnableAppendOnlyContext", () => {
	test("honors explicit on and off settings", () => {
		expect(shouldEnableAppendOnlyContext("on", GENERIC_PROXY)).toBe(true);
		expect(shouldEnableAppendOnlyContext("off", { provider: "deepseek", baseUrl: "https://api.deepseek.com" })).toBe(
			false,
		);
	});

	test("auto enables for DeepSeek", () => {
		expect(shouldEnableAppendOnlyContext("auto", { provider: "deepseek", baseUrl: "https://api.deepseek.com" })).toBe(
			true,
		);
	});

	test("auto enables for Xiaomi Token Plan SGLang HiCache endpoints", () => {
		expect(shouldEnableAppendOnlyContext("auto", XIAOMI_TOKEN_PLAN_ANTHROPIC)).toBe(true);
	});

	test("auto enables when model compat explicitly supports stored requests", () => {
		expect(
			shouldEnableAppendOnlyContext("auto", {
				...GENERIC_PROXY,
				compatConfig: { supportsStore: true },
			}),
		).toBe(true);
	});

	test("auto remains off for unknown providers without prefix-cache signals", () => {
		expect(shouldEnableAppendOnlyContext("auto", GENERIC_PROXY)).toBe(false);
	});

	test("auto enables for local inference providers", () => {
		// Ollama serves both `ollama-chat` (cloud-managed) and the openai-responses
		// path used by locally pulled models — issue #3033 (llama.cpp KV-cache prefix
		// resets every turn without append-only mode).
		expect(shouldEnableAppendOnlyContext("auto", { provider: "ollama", baseUrl: "http://127.0.0.1:11434" })).toBe(
			true,
		);
		expect(shouldEnableAppendOnlyContext("auto", { provider: "ollama-cloud", baseUrl: "https://ollama.com" })).toBe(
			true,
		);
		expect(
			shouldEnableAppendOnlyContext("auto", { provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" }),
		).toBe(true);
		// `llama.cpp` is a built-in provider id (ModelRegistry registers it for keyless local discovery);
		// the allowlist must catch it even when the user reverse-proxies the server through a public host.
		expect(
			shouldEnableAppendOnlyContext("auto", { provider: "llama.cpp", baseUrl: "https://llamacpp.example.com/v1" }),
		).toBe(true);
		expect(shouldEnableAppendOnlyContext("auto", { provider: "llama.cpp", baseUrl: "http://127.0.0.1:8080" })).toBe(
			true,
		);
	});

	test("auto enables for loopback and private baseUrls (user-defined llama.cpp/vLLM)", () => {
		const cases: Array<{ provider: string; baseUrl: string }> = [
			{ provider: "my-llamacpp", baseUrl: "http://localhost:8080/v1" },
			{ provider: "my-vllm", baseUrl: "http://127.0.0.1:8000/v1" },
			{ provider: "my-sglang", baseUrl: "http://[::1]:30000/v1" },
			{ provider: "lan-host", baseUrl: "http://192.168.1.42:11434" },
			{ provider: "lan-host", baseUrl: "http://10.0.0.5:11434" },
			{ provider: "lan-host", baseUrl: "http://172.17.0.3:11434" },
			{ provider: "mdns-host", baseUrl: "http://gpu-box.local:11434" },
		];
		for (const model of cases) {
			expect(shouldEnableAppendOnlyContext("auto", model)).toBe(true);
		}
	});

	test("auto stays off for public hosts that merely share an IP prefix", () => {
		// 172.15.x.x sits just outside the RFC1918 16-31 band.
		expect(shouldEnableAppendOnlyContext("auto", { provider: "x", baseUrl: "http://172.15.0.1/v1" })).toBe(false);
		// 172.32.x.x sits just outside the RFC1918 16-31 band on the other side.
		expect(shouldEnableAppendOnlyContext("auto", { provider: "x", baseUrl: "http://172.32.0.1/v1" })).toBe(false);
		expect(shouldEnableAppendOnlyContext("auto", { provider: "x", baseUrl: "https://example.com/v1" })).toBe(false);
	});

	test("malformed baseUrl never crashes the resolver", () => {
		expect(shouldEnableAppendOnlyContext("auto", { provider: "x", baseUrl: "not a url" })).toBe(false);
	});
});
