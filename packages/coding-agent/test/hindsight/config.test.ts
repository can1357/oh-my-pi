import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

const TOUCHED = [
	"HINDSIGHT_AUTO_RECALL",
	"HINDSIGHT_AUTO_RETAIN",
	"HINDSIGHT_DEBUG",
	"HINDSIGHT_RECALL_MAX_TOKENS",
	"HINDSIGHT_RETAIN_EVERY_N_TURNS",
	"HINDSIGHT_REQUEST_TIMEOUT_MS",
] as const;
const saved = new Map(TOUCHED.map(name => [name, Bun.env[name]]));

function configWith(env: Partial<Record<(typeof TOUCHED)[number], string>>, overrides: Record<string, unknown> = {}) {
	for (const name of TOUCHED) delete Bun.env[name];
	Object.assign(Bun.env, env);
	return loadHindsightConfig(Settings.isolated(overrides));
}

describe("loadHindsightConfig HINDSIGHT_* env parsing", () => {
	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
	});

	it("reads integer variables as a base-10 parseInt prefix", () => {
		const config = configWith({
			HINDSIGHT_REQUEST_TIMEOUT_MS: "5000ms",
			HINDSIGHT_RETAIN_EVERY_N_TURNS: "2.5",
			HINDSIGHT_RECALL_MAX_TOKENS: "512.7",
		});
		expect(config.requestTimeoutMs).toBe(5000);
		expect(config.retainEveryNTurns).toBe(2);
		expect(config.recallMaxTokens).toBe(512);
	});

	it("ignores empty or non-numeric integer variables in favor of settings", () => {
		const config = configWith(
			{ HINDSIGHT_REQUEST_TIMEOUT_MS: "", HINDSIGHT_RECALL_MAX_TOKENS: "lots" },
			{ "hindsight.requestTimeoutMs": 7000, "hindsight.recallMaxTokens": 2048 },
		);
		expect(config.requestTimeoutMs).toBe(7000);
		expect(config.recallMaxTokens).toBe(2048);
	});

	it("treats any non-empty non-truthy boolean value as false", () => {
		const config = configWith({ HINDSIGHT_AUTO_RECALL: "disabled", HINDSIGHT_AUTO_RETAIN: "n" });
		expect(config.autoRecall).toBe(false);
		expect(config.autoRetain).toBe(false);
	});

	it("reads truthy boolean spellings as true and ignores empty values", () => {
		const config = configWith({ HINDSIGHT_DEBUG: "y", HINDSIGHT_AUTO_RETAIN: "" });
		expect(config.debug).toBe(true);
		expect(config.autoRetain).toBe(true);
	});
});
