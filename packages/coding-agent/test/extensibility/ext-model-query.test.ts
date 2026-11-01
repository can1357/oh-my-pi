import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "../../src/extensibility/extensions/loader";
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

/** A session that is live for every test here: the facade is that session's. */
const live = new ExtensionRuntime();
live.beginSession();

describe("createExtensionModelQuery", () => {
	test("current() reflects the live session model, read lazily", () => {
		let active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), undefined, () => active, live);
		expect(q.current()).toEqual(claude);
		active = gpt;
		expect(q.current()).toEqual(gpt);
	});

	test("answers with copies, so an edit stays off the model the host sends requests with", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => claude, live);
		const current = q.current();
		const resolved = q.resolve("anthropic/claude-opus-4-8");
		const listed = q.list().find(entry => entry.id === claude.id);
		for (const handed of [current, resolved, listed]) {
			expect(handed).toEqual(claude);
			expect(handed).not.toBe(claude);
		}
		if (!current) throw new Error("expected the session model");
		current.baseUrl = "https://attacker.test";
		expect(claude.baseUrl).toBe("https://example.test");
	});

	test("resolve() matches model strings through the core resolver", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined, live);
		expect(q.resolve("anthropic/claude-opus-4-8")).toEqual(claude);
		expect(q.resolve("gpt-5.4")?.provider).toBe("openai");
		expect(q.resolve("definitely-not-a-model")).toBeUndefined();
	});

	test("resolve() honors configured role aliases via the same settings-backed path as core", () => {
		const settings = Settings.isolated({ modelRoles: { slow: "anthropic/claude-opus-4-8" } });
		const q = createExtensionModelQuery(registry(), settings, () => undefined, live);
		expect(q.resolve("@slow")).toEqual(claude);
	});

	test("family() groups a vendor's point releases and separates vendors", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined, live);
		expect(q.family(claude)).toBe(q.family(claudePrev));
		expect(q.family(claude)).not.toBe(q.family(gpt));
	});

	test("is its session's: every member refuses once that session has gone, before it reads the host", () => {
		const runtime = new ExtensionRuntime();
		const end = runtime.beginSession();
		let reads = 0;
		const host = {
			getAvailable: () => {
				reads++;
				return available;
			},
		} as unknown as ModelRegistry;
		const q = createExtensionModelQuery(
			host,
			undefined,
			() => {
				reads++;
				return claude;
			},
			runtime.forSession(),
		);
		end();
		// The next session is live: the facade stays the one that has gone.
		runtime.beginSession();
		const outcomes = [
			() => q.current(),
			() => q.list(),
			() => q.resolve("anthropic/claude-opus-4-8"),
			() => q.family(claude),
		].map(call => {
			try {
				call();
				return "answered";
			} catch (error) {
				return String(error);
			}
		});
		expect({ outcomes, reads }).toEqual({
			outcomes: Array(4).fill(expect.stringContaining("Extension session retired")),
			reads: 0,
		});
	});
});
