import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import type { ModelsListingSource } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { renderProviderModels } from "@oh-my-pi/pi-coding-agent/cli/models-cli";

const PROVIDER = "google-antigravity";
const REASON =
	"Google may restrict accounts that use Antigravity outside its own apps, so this provider is paused for now.";

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function pauseProvider(): void {
	vi.spyOn(compatAuth, "providerDisabledReason").mockImplementation(provider =>
		provider === PROVIDER ? REASON : undefined,
	);
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
});

const mixed: ModelsListingSource = {
	getAvailable: () => [chatModel],
	getError: () => undefined,
};

describe("paused providers in `omp models`", () => {
	it("names the pause instead of reporting no matches when the filter is a paused provider", () => {
		pauseProvider();
		const output = stripAnsi(render(pausedOnly, PROVIDER));
		expect(output).toContain(PROVIDER);
		expect(output).toContain(REASON);
		expect(output).not.toContain(`No models matching "${PROVIDER}"`);
	});

	it("keeps the no-match message for unknown providers, without an unrelated pause footer", () => {
		pauseProvider();
		const output = stripAnsi(render(mixed, "no-such-provider"));
		expect(output).toContain('No models matching "no-such-provider"');
		expect(output).not.toContain("Paused providers");
	});

	it("keeps a filtered live listing free of movement from other providers", () => {
		pauseProvider();
		const output = stripAnsi(render(mixed, "myproxy"));
		expect(output).toContain("chat-model");
		expect(output).not.toContain("Paused providers");
		expect(output).not.toContain(REASON);
	});

	it("lists paused providers, and live tables, when nothing is filtered", () => {
		pauseProvider();
		const output = stripAnsi(render(mixed, undefined));
		expect(output).toContain("chat-model");
		expect(output).toContain("Paused providers");
		expect(output).toContain(REASON);
	});

	it("carries paused providers in --json", () => {
		pauseProvider();
		const parsed = JSON.parse(render(pausedOnly, PROVIDER, true)) as {
			models: unknown[];
			paused?: { provider: string; reason: string }[];
		};
		expect(parsed.models).toEqual([]);
		expect(parsed.paused).toEqual([{ provider: PROVIDER, reason: REASON }]);
	});

	it("omits the paused key from --json when nothing is paused", () => {
		const source: ModelsListingSource = { getAvailable: () => [chatModel], getError: () => undefined };
		const parsed = JSON.parse(render(source, undefined, true)) as { models: unknown[]; paused?: unknown };
		expect(parsed.models.length).toBe(1);
		expect(parsed.paused).toBeUndefined();
	});
});
