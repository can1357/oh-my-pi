import { afterEach, describe, expect, it } from "bun:test";
import {
	CallableLlmBackend,
	callHostLlm,
	getHostLlmBackend,
	resetHostLlmBackendForTests,
	setHostLlmBackend,
} from "@oh-my-pi/pi-mnemopi/core/llm-backends";

afterEach(() => resetHostLlmBackendForTests());

describe("host LLM backend registry", () => {
	it("sets, gets, and clears the process-global backend", () => {
		expect(getHostLlmBackend()).toBeNull();
		const backend = new CallableLlmBackend("test", () => "ok");
		setHostLlmBackend(backend);
		expect(getHostLlmBackend()).toBe(backend);
		setHostLlmBackend(null);
		expect(getHostLlmBackend()).toBeNull();
	});

	it("returns null without a backend", async () => {
		expect(await callHostLlm("anything", { maxTokens: 64 })).toBeNull();
	});

	it("passes completion options through", async () => {
		const captured: Record<string, unknown> = {};
		setHostLlmBackend(
			new CallableLlmBackend("test", (prompt, opts) => {
				captured.prompt = prompt;
				captured.maxTokens = opts?.maxTokens;
				captured.temperature = opts?.temperature;
				captured.timeout = opts?.timeout;
				captured.provider = opts?.provider;
				captured.model = opts?.model;
				return "out";
			}),
		);

		expect(
			await callHostLlm("hello", {
				maxTokens: 128,
				temperature: 0.1,
				timeout: 7.5,
				provider: "openai-codex",
				model: "gpt-5.1-mini",
			}),
		).toBe("out");
		expect(captured).toEqual({
			prompt: "hello",
			maxTokens: 128,
			temperature: 0.1,
			timeout: 7.5,
			provider: "openai-codex",
			model: "gpt-5.1-mini",
		});
	});

	it("swallows backend exceptions", async () => {
		setHostLlmBackend(
			new CallableLlmBackend("boom", () => {
				throw new Error("provider exploded");
			}),
		);
		expect(await callHostLlm("anything", { maxTokens: 64 })).toBeNull();
	});
});
