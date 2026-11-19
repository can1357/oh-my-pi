import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { judgeAdvisorReview } from "@oh-my-pi/pi-coding-agent/advisor/review-gate";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

const JEV = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

const LOCAL = getBundledModel("local", "qwen2.5-1.5b");
if (!LOCAL) throw new Error("Expected bundled local judge model");

const UPDATE = "ran `bun test`; 3 failures in sync engine";

function gate(mode: "off" | "auto" | "on", judge: Model<Api>) {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("typesafe", "ts-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/advisor-review-gate-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([judge]);
	const settings = Settings.isolated({
		"advisor.judgeGate": mode,
		modelRoles: { judge: `${judge.provider}/${judge.id}` },
	});
	return judgeAdvisorReview(UPDATE, { settings, registry, sessionId: "s", timeoutMs: 4_000 });
}

/** Serve one System One reply with `destructive` at `p` and every other risk at 0.01. */
function serveJev(p: number) {
	const noul = (value: number) => ({ type: "noul", noul: value });
	return vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async () =>
			Response.json({
				model: "jev-1.14.0",
				answers: { destructive: noul(p), guessing: noul(0.01), looping: noul(0.01), shortcut: noul(0.01) },
				usage: { input_tokens: 8, output_tokens: 4 },
			}),
		),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("advisor.judgeGate", () => {
	it.each([
		["holds when every risk is under the band", 0.19, false],
		["reviews when one risk reaches the band", 0.2, true],
	] as const)("auto with a native judge %s", async (_label, p, review) => {
		serveJev(p);
		expect(await gate("auto", JEV)).toBe(review);
	});

	it("auto without a native judge reviews ungated and asks no judge", () => {
		const complete = vi.spyOn(tinyModelClient, "complete").mockResolvedValue("no");
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		expect(gate("auto", LOCAL)).toBeUndefined();
		expect(complete).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("on gates with a prompted judge, holding on its one-hot no", async () => {
		const complete = vi
			.spyOn(tinyModelClient, "complete")
			.mockResolvedValue("destructive: no\nguessing: no\nlooping: no\nshortcut: no");

		expect(await gate("on", LOCAL)).toBe(false);
		expect(complete).toHaveBeenCalled();
	});

	it("off asks no judge", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		expect(gate("off", JEV)).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
