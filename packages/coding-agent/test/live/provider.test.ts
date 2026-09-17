import { describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { liveProviderUsageExhausted, parseLiveProviderArg } from "../../src/live/provider-select";

describe("parseLiveProviderArg", () => {
	test("maps grok aliases", () => {
		expect(parseLiveProviderArg("grok")).toBe("grok");
		expect(parseLiveProviderArg("xai")).toBe("grok");
		expect(parseLiveProviderArg("  Grok  ")).toBe("grok");
	});

	test("maps codex aliases", () => {
		expect(parseLiveProviderArg("codex")).toBe("codex");
		expect(parseLiveProviderArg("openai")).toBe("codex");
		expect(parseLiveProviderArg("openai-codex")).toBe("codex");
	});

	test("ignores empty and unknown args", () => {
		expect(parseLiveProviderArg("")).toBeUndefined();
		expect(parseLiveProviderArg("hybrid")).toBeUndefined();
	});
});

function usageEntry(
	provider: string,
	label: string,
	usedFraction: number,
	status: "ok" | "exhausted" | "warning",
) {
	return {
		recordedAt: Date.now(),
		provider,
		accountKey: "primary",
		limitId: label,
		label,
		windowLabel: "7 days",
		usedFraction,
		status,
	};
}

describe("liveProviderUsageExhausted", () => {
	test("skips Codex weekly exhausted but not Spark", () => {
		const authStorage = {
			listUsageHistory: ({ provider }: { provider?: string } = {}) => {
				const rows = [
					usageEntry("openai-codex", "7 days", 1, "exhausted"),
					usageEntry("openai-codex", "7 days (Spark)", 0, "ok"),
					usageEntry("xai-oauth", "GrokChat (Weekly)", 0.03, "ok"),
				];
				return provider ? rows.filter(row => row.provider === provider) : rows;
			},
		} as AuthStorage;

		expect(liveProviderUsageExhausted(authStorage, "openai-codex")).toBe(true);
		expect(liveProviderUsageExhausted(authStorage, "xai-oauth")).toBe(false);
	});
});
