import { describe, expect, it } from "bun:test";
import { isLocalOpenAICompatBackend } from "../src/compat/resolve";

/**
 * The exported local-backend predicate is the single source of truth for
 * "one process, one KV cache": known local provider ids plus loopback/private
 * baseUrls on custom endpoints. Proxy ids stay excluded because their
 * concurrency is bounded by the remote upstream.
 */
describe("isLocalOpenAICompatBackend", () => {
	it("flags known local provider ids without a baseUrl", () => {
		for (const provider of ["llama.cpp", "lm-studio", "vllm", "ollama"]) {
			expect(isLocalOpenAICompatBackend({ provider })).toBe(true);
		}
	});

	it("resolves the backend through providerType over provider", () => {
		expect(isLocalOpenAICompatBackend({ provider: "openai", providerType: "ollama" })).toBe(true);
	});

	it("treats loopback and private baseUrls on custom endpoints as local", () => {
		for (const baseUrl of [
			"http://localhost:8080/v1",
			"http://127.0.0.1:11434",
			"http://my-machine.local:8080/v1",
			"http://10.0.0.5:8000/v1",
			"http://192.168.1.10:8000/v1",
			"http://172.16.0.1:8000/v1",
		]) {
			expect(isLocalOpenAICompatBackend({ provider: "my-endpoint", baseUrl })).toBe(true);
		}
	});

	it("keeps public remote endpoints non-local", () => {
		expect(isLocalOpenAICompatBackend({ provider: "my-endpoint", baseUrl: "https://api.example.com/v1" })).toBe(
			false,
		);
		expect(isLocalOpenAICompatBackend({ provider: "my-endpoint" })).toBe(false);
	});

	it("excludes proxy ids even on a loopback baseUrl", () => {
		expect(isLocalOpenAICompatBackend({ provider: "litellm", baseUrl: "http://localhost:4000/v1" })).toBe(false);
	});
});
