import { describe, expect, it } from "bun:test";
import { AGENT_COLOR_HEX, agentIdentity } from "../src/overlays/agent-identity";

describe("agentIdentity", () => {
	it("gives Main blue and every other agent a stable colour from the other six", () => {
		expect(agentIdentity("Main")).toEqual({ id: "Main", label: "Main", color: "blue" });
		// FNV-1a of the full id pins these, so another surface hashing the same id draws the same colour.
		expect(agentIdentity("CursorChecks.Scout")).toEqual({ id: "CursorChecks.Scout", label: "Scout", color: "purple" });
		expect(agentIdentity("Scout")).toEqual({ id: "Scout", label: "Scout", color: "teal" });

		const colors = new Set<string>();
		for (let index = 0; index < 200; index++) colors.add(agentIdentity(`Main.Agent${index}`).color);
		expect([...colors].sort()).toEqual(
			Object.keys(AGENT_COLOR_HEX)
				.filter(color => color !== "blue")
				.sort(),
		);
	});
});
