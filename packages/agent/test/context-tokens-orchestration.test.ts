import { describe, expect, it } from "bun:test";
import { calculateContextTokens, calculatePromptTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Usage } from "@oh-my-pi/pi-ai";

function usage(overrides: Partial<Usage>): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

describe("calculateContextTokens", () => {
	it("excludes provider orchestration tokens from context sizing", () => {
		// Codex-style turn: conversation prefix is ~186k, orchestration adds 5.5k;
		// context sizing must stay on the conversation, not the billable total.
		const u = usage({
			input: 5_517,
			output: 29,
			cacheRead: 181_248,
			cacheWrite: 0,
			totalTokens: 186_794 + 5_629,
			orchestration: { input: 5_629 },
		});
		expect(calculateContextTokens(u)).toBe(186_794);
		expect(calculatePromptTokens(u)).toBe(5_517 + 181_248);
	});

	it("keeps native totalTokens when no orchestration sidecar is present", () => {
		const u = usage({ input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115 });
		expect(calculateContextTokens(u)).toBe(115);
	});
});
