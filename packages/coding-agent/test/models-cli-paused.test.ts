import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelsListingSource } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { renderProviderModels } from "@oh-my-pi/pi-coding-agent/cli/models-cli";

const REASON =
	"Google may restrict accounts that use Antigravity outside its own apps, so this provider is paused for now.";

afterEach(() => {
	vi.restoreAllMocks();
});

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(source: ModelsListingSource, pattern: string | undefined, json = false): string {
	const output: string[] = [];
	spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	renderProviderModels(source, "ls", pattern, json);
	vi.restoreAllMocks();
	return output.join("");
}

const pausedOnly: ModelsListingSource = {
	getAvailable: () => [],
	getError: () => undefined,
	getPausedProviders: () => [{ provider: "google-antigravity", reason: REASON }],
};

/** One live model elsewhere, so a filtered miss renders the "no matches" line rather than "no models". */
const chatModel: Model<Api> = buildModel({
	id: "chat-model",
	name: "Chat Model",
	api: "openai-completions",
	provider: "myproxy",
	baseUrl: "https://proxy.example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
} as ModelSpec);

const mixed: ModelsListingSource = {
	getAvailable: () => [chatModel],
	getError: () => undefined,
	getPausedProviders: () => [{ provider: "google-antigravity", reason: REASON }],
};

describe("paused providers in `omp models`", () => {
	it("names the pause instead of reporting no matches when the filter is a paused provider", () => {
		const output = stripAnsi(render(pausedOnly, "google-antigravity"));
		expect(output).toContain("google-antigravity");
		expect(output).toContain(REASON);
		expect(output).not.toContain('No models matching "google-antigravity"');
	});

	it("keeps the no-match message for unknown providers and still reports the pause", () => {
		const output = stripAnsi(render(mixed, "no-such-provider"));
		expect(output).toContain('No models matching "no-such-provider"');
		expect(output).toContain("Paused providers");
		expect(output).toContain(REASON);
	});

	it("lists paused providers when nothing is filtered", () => {
		const output = stripAnsi(render(pausedOnly, undefined));
		expect(output).toContain("Paused providers");
		expect(output).toContain(REASON);
	});

	it("carries paused providers in --json", () => {
		const parsed = JSON.parse(render(pausedOnly, "google-antigravity", true)) as {
			models: unknown[];
			paused?: { provider: string; reason: string }[];
		};
		expect(parsed.models).toEqual([]);
		expect(parsed.paused).toEqual([{ provider: "google-antigravity", reason: REASON }]);
	});
});
