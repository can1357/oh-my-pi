import { describe, expect, it } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";

// Contract: a named `agent.profile` retargets every role-resolving agent slot,
// while explicit `modelRoles` still wins per-role. This is what lets a user keep
// one bundled "optimal model per slot" preset and swap it with a single setting.
describe("agent.profile role resolution", () => {
	it("returns the profile's model when no explicit role is set", () => {
		const settings = Settings.isolated({
			"agent.profile": "frugal",
			"agent.profiles": { frugal: { slow: "kimi-code/kimi-for-coding", task: "minimax-code/MiniMax-M3" } },
		});
		expect(settings.getModelRole("slow")).toBe("kimi-code/kimi-for-coding");
		expect(settings.getModelRole("task")).toBe("minimax-code/MiniMax-M3");
	});

	it("explicit modelRoles wins over the active profile per-role", () => {
		const settings = Settings.isolated({
			"agent.profile": "frugal",
			"agent.profiles": { frugal: { slow: "kimi-code/kimi-for-coding", task: "minimax-code/MiniMax-M3" } },
			modelRoles: { slow: "anthropic/claude-sonnet-5" },
		});
		// explicit override on `slow`
		expect(settings.getModelRole("slow")).toBe("anthropic/claude-sonnet-5");
		// profile still supplies `task` (no explicit entry)
		expect(settings.getModelRole("task")).toBe("minimax-code/MiniMax-M3");
	});

	it("getModelRoles merges profile under explicit entries", () => {
		const settings = Settings.isolated({
			"agent.profile": "frugal",
			"agent.profiles": { frugal: { slow: "kimi-code/kimi-for-coding", smol: "nvidia/gpt-oss-20b" } },
			modelRoles: { slow: "anthropic/claude-sonnet-5" },
		});
		expect(settings.getModelRoles()).toEqual({
			slow: "anthropic/claude-sonnet-5", // explicit wins
			smol: "nvidia/gpt-oss-20b", // from profile
		});
	});

	it("no profile set falls back to explicit modelRoles only", () => {
		const settings = Settings.isolated({ modelRoles: { slow: "anthropic/claude-sonnet-5" } });
		expect(settings.getModelRole("slow")).toBe("anthropic/claude-sonnet-5");
		expect(settings.getModelRole("task")).toBeUndefined();
	});

	it("a profile name with no matching entry is a no-op", () => {
		const settings = Settings.isolated({
			"agent.profile": "nonexistent",
			"agent.profiles": { frugal: { slow: "kimi-code/kimi-for-coding" } },
		});
		expect(settings.getModelRole("slow")).toBeUndefined();
		expect(settings.getModelRoles()).toEqual({});
	});
});
