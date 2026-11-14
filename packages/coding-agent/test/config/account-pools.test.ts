import { describe, expect, it } from "bun:test";
import {
	resolveSessionAccountPool,
	validateAgentAccountPools,
	validateSessionAccountPools,
} from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTaskAgentAccountPools } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("task.agentAccountPools", () => {
	it("keeps an empty provider list as a deny-all pool and lets null clear an agent", () => {
		expect(validateAgentAccountPools(undefined)).toEqual({});
		expect(validateAgentAccountPools(null)).toEqual({});
		expect(
			validateAgentAccountPools({
				reviewer: { anthropic: ["email:a@example.com|org:org-a"], "openai-codex": [] },
				cleared: null,
			}),
		).toEqual({ reviewer: { anthropic: ["email:a@example.com|org:org-a"], "openai-codex": [] } });
	});

	it("rejects every malformed level instead of widening the agent to all accounts", () => {
		const malformed: [unknown, string][] = [
			["reviewer", "Invalid task.agentAccountPools:"],
			[[], "Invalid task.agentAccountPools:"],
			[{ reviewer: ["email:a@example.com"] }, "Invalid task.agentAccountPools.reviewer:"],
			[{ reviewer: { anthropic: "email:a@example.com" } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: null } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [""] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [" email:a@example.com"] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [42] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
		];
		for (const [value, message] of malformed) {
			expect(() => validateAgentAccountPools(value)).toThrow(message);
		}
	});

	it("fails settings load on a malformed pool", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentAccountPools": { reviewer: { anthropic: "email:a@example.com" } } },
			}),
		).rejects.toThrow("Invalid task.agentAccountPools.reviewer.anthropic:");
	});

	it("keeps an agent named __proto__ restricted across settings layers", async () => {
		// YAML parses `__proto__` as an own key; layer merging and validation must keep it one.
		const tempDir = TempDir.createSync("@pi-account-pools-");
		try {
			const overlay = tempDir.join("overlay.yml");
			await Bun.write(overlay, "task:\n  agentAccountPools:\n    __proto__:\n      anthropic: []\n");
			const settings = await Settings.loadIsolated({
				inMemory: true,
				configFiles: [overlay],
				overrides: { "task.agentAccountPools": { reviewer: { anthropic: [] } } },
			});
			// Dispatch and revival read the pools through the validator.
			const pools = validateAgentAccountPools(cfgTaskAgentAccountPools.get(settings));
			expect(Object.getOwnPropertyDescriptor(pools, "__proto__")?.value).toEqual({ anthropic: [] });
			expect(pools.reviewer).toEqual({ anthropic: [] });
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("auth.sessionAccountPools", () => {
	it("resolves only the explicitly selected named pool", () => {
		const company = { anthropic: ["email:company@example.com"] };
		const personal = { "openai-codex": ["account:personal"] };
		const pools = { company, personal };

		expect(resolveSessionAccountPool(pools, "company")).toEqual(company);
		expect(resolveSessionAccountPool(pools, "personal")).toEqual(personal);
		expect(resolveSessionAccountPool(pools, "missing")).toBeUndefined();
	});

	it("keeps empty provider lists as deny-all and copies __proto__ as data", () => {
		const providers = Object.create(null) as Record<string, readonly string[]>;
		providers.__proto__ = [];
		const named = Object.create(null) as Record<string, Record<string, readonly string[]>>;
		named.__proto__ = providers;
		const validated = validateSessionAccountPools(named);

		expect(Object.hasOwn(validated, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(validated.__proto__, "__proto__")?.value).toEqual([]);
	});

	it("rejects malformed maps instead of widening the top-level session", async () => {
		const malformed: [unknown, string][] = [
			[[], "expected a map of pool name"],
			[{ "": {} }, "pool names must be non-empty"],
			[{ " padded": {} }, "pool names must be non-empty"],
			[{ company: [] }, ".company: expected a map"],
			[{ company: { "": [] } }, "provider ids must be non-empty"],
			[{ company: { anthropic: [" padded"] } }, ".company.anthropic:"],
		];
		for (const [value, message] of malformed) {
			expect(() => validateSessionAccountPools(value)).toThrow(message);
		}

		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "auth.sessionAccountPools": { company: { anthropic: [""] } } },
			}),
		).rejects.toThrow("Invalid auth.sessionAccountPools.company.anthropic:");
	});
});
