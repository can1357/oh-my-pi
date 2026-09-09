import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createExtensionModelQuery } from "../../src/extensibility/extensions/model-api";

function model(id: string, name: string, provider: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const claude = model("claude-opus-4-8", "Claude Opus 4.8", "anthropic");
const claudePrev = model("claude-opus-4-7", "Claude Opus 4.7", "anthropic");
const gpt = model("gpt-5.4", "GPT-5.4", "openai");

const available = [claude, gpt] as Model<Api>[];

/** Minimal registry stub: only the methods the facade and core resolver touch. */
function registry(): ModelRegistry {
	return {
		getAvailable: () => available,
	} as unknown as ModelRegistry;
}

describe("createExtensionModelQuery", () => {
	test("list() and current() pass through to the registry and session model", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => gpt);
		expect(q.list()).toEqual(available);
		expect(q.current()).toBe(gpt);
	});

	test("current() reflects the live session model, read lazily", () => {
		let active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), undefined, () => active);
		expect(q.current()).toBe(claude);
		active = gpt;
		expect(q.current()).toBe(gpt);
	});

	test("resolve() matches model strings through the core resolver", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.resolve("anthropic/claude-opus-4-8")).toBe(claude);
		expect(q.resolve("gpt-5.4")?.provider).toBe("openai");
		expect(q.resolve("definitely-not-a-model")).toBeUndefined();
	});

	test("resolve() honors configured role aliases via the same settings-backed path as core", () => {
		const settings = {
			getModelRole: (role: string) => (role === "slow" ? "anthropic/claude-opus-4-8" : undefined),
		} as unknown as Settings;
		const q = createExtensionModelQuery(registry(), settings, () => undefined);
		expect(q.resolve("@slow")).toBe(claude);
	});

	test("family() groups a vendor's point releases and separates vendors", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.family(claude)).toBe(q.family(claudePrev));
		expect(q.family(claude)).not.toBe(q.family(gpt));
	});
});
