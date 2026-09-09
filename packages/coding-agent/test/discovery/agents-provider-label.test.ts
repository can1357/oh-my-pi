/**
 * Regression test for #5821:
 * The `.agent`/`.agents` config-standard provider must not present as "a list
 * of agents" in the /extensions dashboard — its tab label collided with the
 * first-class /agents subagents feature even though it surfaces only skills,
 * rules, prompts, commands, and context/system files (never agents).
 */
import { describe, expect, test } from "bun:test";
import { getAllProvidersInfo } from "@oh-my-pi/pi-coding-agent/discovery";

describe("agents (config-standard) provider label", () => {
	test("display name disambiguates from the /agents subagents feature", () => {
		const info = getAllProvidersInfo().find(p => p.id === "agents");
		expect(info).toBeDefined();

		// It surfaces .agent/.agents config-standard capabilities, never agents.
		expect(info?.capabilities).not.toContain("agent");
		expect(info?.capabilities).toEqual(expect.arrayContaining(["skills", "rules", "prompts"]));

		// The tab label (used verbatim by buildProviderTabs) must reference the
		// directories it scans, not read as "a list of agents".
		expect(info?.displayName).toContain(".agent");
		expect(info?.displayName).not.toBe("Agents (standard)");
	});
});
