import { describe, expect, it } from "bun:test";
import { AGENT_COLOR_HEX, agentColor } from "../src/overlays/agent-identity";

describe("agentColor", () => {
	it("gives Main blue and every other agent a stable colour from the other six", () => {
		expect(agentColor("Main")).toBe("blue");
		// FNV-1a of the full id pins these, so another surface hashing the same id draws the same colour.
		expect(agentColor("CursorChecks.Scout")).toBe("purple");
		expect(agentColor("Scout")).toBe("teal");

		const colors = new Set<string>();
		for (let index = 0; index < 200; index++) colors.add(agentColor(`Main.Agent${index}`));
		expect([...colors].sort()).toEqual(
			Object.keys(AGENT_COLOR_HEX)
				.filter(color => color !== "blue")
				.sort(),
		);
	});
});
