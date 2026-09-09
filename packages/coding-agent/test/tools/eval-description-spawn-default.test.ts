import { describe, expect, it } from "bun:test";
import { getEvalToolDescription } from "../../src/tools/eval";

describe("eval tool description", () => {
	it("advertises the first allowed spawn as the agent() default", () => {
		const description = getEvalToolDescription({ py: true, js: false, spawns: "fact-finder,oracle" });

		expect(description).toContain('agent(prompt, agent?="fact-finder"');
		expect(description).toContain("Allowed agents: `fact-finder`, `oracle`.");
	});

	it("omits agent() when spawning is disabled", () => {
		const description = getEvalToolDescription({ py: true, js: false, spawns: "" });

		expect(description).not.toContain("agent(prompt");
		expect(description).not.toContain("<dag>");
	});
});
