/**
 * Contracts for the shared lineup resolver: ranked candidates, the configurable
 * family policy, and the content hash that names a resolved lineup. Extension
 * packages that own their own execution protocol resolve rosters through
 * `resolvePanelLineup`, so these are the guarantees they build on.
 */

import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	PanelConfigError,
	type PanelLineupContext,
	type PanelRole,
	parsePanelSettings,
	resolvePanelLineup,
} from "@oh-my-pi/pi-coding-agent/panel";

const claude = getBundledModel("anthropic", "claude-sonnet-4-5");
const gpt = getBundledModel("openai", "gpt-5.4");
const gptMini = getBundledModel("openai", "gpt-5-mini");
if (!claude || !gpt || !gptMini) throw new Error("Expected bundled test models");

function context(available: Model[]): PanelLineupContext {
	return {
		settings: Settings.isolated({}),
		modelRegistry: { getAvailable: () => available, hasConfiguredAuth: () => true },
	};
}

function independent(members: PanelRole["members"], extra: Partial<PanelRole> = {}): PanelRole {
	return { strategy: "independent", members, ...extra };
}

describe("candidate resolution", () => {
	test("falls through to a later candidate and records which one resolved", () => {
		const role = independent([
			{ model: "anthropic/claude-sonnet-4-5" },
			{ model: "openai/gpt-4.9-nonexistent", fallbacks: ["openai/gpt-5.4"] },
		]);

		const lineup = resolvePanelLineup({ context: context([claude, gpt]), roleId: "r", role, taskMode: "answer" });

		expect(lineup.members.map(member => member.requestedSelector)).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-5.4",
		]);
		expect(lineup.members[1]?.selector).toBe("openai/gpt-5.4");
		expect(lineup.members[1]?.model).toBe("openai/gpt-4.9-nonexistent");
	});

	test("reports every candidate when the whole list is unavailable", () => {
		const role = independent([
			{ model: "anthropic/claude-sonnet-4-5" },
			{ model: "openai/absent-a", fallbacks: ["openai/absent-b"] },
		]);

		expect(() => resolvePanelLineup({ context: context([claude]), roleId: "r", role, taskMode: "answer" })).toThrow(
			/no candidate is available: "openai\/absent-a", "openai\/absent-b"/,
		);
	});

	test("parses a bare candidate array into a primary plus ordered fallbacks", () => {
		const parsed = parsePanelSettings({
			roles: {
				ranked: {
					strategy: "independent",
					members: [{ model: ["anthropic/claude-sonnet-4-5"] }, { model: ["openai/absent", "openai/gpt-5.4"] }],
				},
			},
			personas: {},
		});

		expect(parsed.roles.ranked?.members[1]).toEqual({ model: "openai/absent", fallbacks: ["openai/gpt-5.4"] });
	});

	test("rejects a candidate list that also carries an explicit fallbacks key", () => {
		expect(() =>
			parsePanelSettings({
				roles: {
					ranked: {
						strategy: "independent",
						members: [
							{ model: "anthropic/claude-sonnet-4-5" },
							{ model: ["openai/gpt-5.4"], fallbacks: ["openai/gpt-5-mini"] },
						],
					},
				},
				personas: {},
			}),
		).toThrow(PanelConfigError);
	});
});

describe("family policy", () => {
	test("independent roles still reject two members on one family by default", () => {
		const role = independent([{ model: "openai/gpt-5.4" }, { model: "openai/gpt-5-mini" }]);

		expect(() =>
			resolvePanelLineup({ context: context([gpt, gptMini]), roleId: "r", role, taskMode: "answer" }),
		).toThrow(/duplicate resolved model family/);
	});

	test("an unknown role key is rejected rather than silently ignored", () => {
		expect(() =>
			parsePanelSettings({
				roles: {
					loosened: {
						strategy: "independent",
						members: [{ model: "openai/gpt-5.4" }, { model: "openai/gpt-5-mini" }],
						distinctFamilies: false,
					},
				},
				personas: {},
			}),
		).toThrow(PanelConfigError);
	});

	test("a personas role with a floor fails when its lineup collapses onto one family", () => {
		const role: PanelRole = {
			strategy: "personas",
			members: [
				{ model: "openai/gpt-5.4", persona: "analyst" },
				{ model: "openai/gpt-5-mini", persona: "reviewer" },
			],
			minFamilies: 2,
		};

		expect(() =>
			resolvePanelLineup({ context: context([gpt, gptMini]), roleId: "r", role, taskMode: "answer" }),
		).toThrow(/resolved 1 distinct model families, need 2/);
	});

	test("a one-seat lineup resolves an unclassified model, claiming no diversity", () => {
		const opaque = { ...gpt, identity: { ...gpt.identity, class: "unknown" as const } };
		const role = independent([{ model: "openai/gpt-5.4" }]);

		const lineup = resolvePanelLineup({ context: context([opaque]), roleId: "r", role, taskMode: "answer" });

		expect(lineup.members[0]?.family).toBe("");
	});

	test("a multi-seat lineup still fails closed on an unclassified model", () => {
		const opaque = { ...gptMini, identity: { ...gptMini.identity, class: "unknown" as const } };
		const role = independent([{ model: "anthropic/claude-sonnet-4-5" }, { model: "openai/gpt-5-mini" }]);

		expect(() =>
			resolvePanelLineup({ context: context([claude, opaque]), roleId: "r", role, taskMode: "answer" }),
		).toThrow(/no known model family/);
	});

	test("rejects a floor that no lineup of this size could satisfy", () => {
		expect(() =>
			parsePanelSettings({
				roles: {
					impossible: {
						strategy: "independent",
						members: [{ model: "anthropic/claude-sonnet-4-5" }, { model: "openai/gpt-5.4" }],
						minFamilies: 3,
					},
				},
				personas: {},
			}),
		).toThrow(/cannot exceed the 2 configured members/);
	});
});

describe("lineup hash", () => {
	test("names the served routes, not the requested candidates", () => {
		const direct = independent([{ model: "anthropic/claude-sonnet-4-5" }, { model: "openai/gpt-5.4" }]);
		const viaFallback = independent([
			{ model: "anthropic/claude-sonnet-4-5" },
			{ model: "openai/absent", fallbacks: ["openai/gpt-5.4"] },
		]);

		const first = resolvePanelLineup({
			context: context([claude, gpt]),
			roleId: "r",
			role: direct,
			taskMode: "answer",
		});
		const second = resolvePanelLineup({
			context: context([claude, gpt]),
			roleId: "other",
			role: viaFallback,
			taskMode: "answer",
		});

		expect(first.lineupHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(second.lineupHash).toBe(first.lineupHash);
	});

	test("changes when a fallback serves a different model than the primary would", () => {
		const role = independent([
			{ model: "anthropic/claude-sonnet-4-5" },
			{ model: "openai/gpt-5.4", fallbacks: ["openai/gpt-5-mini"] },
		]);

		const primary = resolvePanelLineup({ context: context([claude, gpt]), roleId: "r", role, taskMode: "answer" });
		const degraded = resolvePanelLineup({
			context: context([claude, gptMini]),
			roleId: "r",
			role,
			taskMode: "answer",
		});

		expect(degraded.lineupHash).not.toBe(primary.lineupHash);
	});

	test("changes when the diversity policy that admitted the lineup changes", () => {
		const strict = independent([{ model: "anthropic/claude-sonnet-4-5" }, { model: "openai/gpt-5.4" }], {
			minFamilies: 2,
		});
		const loose = independent([{ model: "anthropic/claude-sonnet-4-5" }, { model: "openai/gpt-5.4" }]);

		const strictLineup = resolvePanelLineup({
			context: context([claude, gpt]),
			roleId: "r",
			role: strict,
			taskMode: "answer",
		});
		const looseLineup = resolvePanelLineup({
			context: context([claude, gpt]),
			roleId: "r",
			role: loose,
			taskMode: "answer",
		});

		expect(strictLineup.lineupHash).not.toBe(looseLineup.lineupHash);
	});
});
