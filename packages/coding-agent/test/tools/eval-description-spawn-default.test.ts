import { describe, expect, it } from "bun:test";
import { getEvalDocTopics } from "../../src/tools/eval";

describe("eval agents topic", () => {
	it("advertises the first allowed spawn as the agent() default", () => {
		const agents = getEvalDocTopics({ py: true, js: false, spawns: "fact-finder,oracle" }).agents;

		expect(agents).toContain('agent(prompt, agent?="fact-finder"');
		expect(agents).toContain("Allowed agents: `fact-finder`, `oracle`.");
	});
});
