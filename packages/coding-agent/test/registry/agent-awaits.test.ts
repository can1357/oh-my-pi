import { describe, expect, it } from "bun:test";
import { AgentAwaits } from "@oh-my-pi/pi-coding-agent/registry/agent-awaits";

describe("AgentAwaits", () => {
	it("names the chain through which an agent waits on another", () => {
		const awaits = new AgentAwaits();
		awaits.hold("B", ["C"], { interruptible: true, message: true });
		awaits.hold("C", ["A"], { interruptible: false });
		expect(awaits.blockedVia("B", "A", 0)).toEqual(["C"]);
		expect(awaits.blockedVia("C", "A", 0)).toEqual([]);
		expect(awaits.blockedVia("A", "B", 0)).toBeUndefined();
	});

	it("a message sent after an interruptible block began ends it", () => {
		const awaits = new AgentAwaits();
		awaits.hold("B", ["A"], { interruptible: true, message: true });
		expect(awaits.blocksOn("B", "A", Date.now() + 1)).toBe(false);
		expect(awaits.blocksOn("B", "A", 0)).toBe(true);
	});

	it("counts as waiting on an agent only the blocks its turn ending leaves in place", () => {
		const awaits = new AgentAwaits();
		// A reply wait on A, and a wait on it in turn.
		awaits.hold("B", ["A"], { interruptible: true, message: true });
		awaits.hold("D", ["B"], { interruptible: true });
		// A wait on A's result: A finishing ends it.
		awaits.hold("P", ["A"], { interruptible: true });
		// A wait another agent can still end.
		awaits.hold("E", ["A", "F"], { interruptible: true, message: true });
		expect(awaits.waitersOn("A")).toEqual([
			{ waiter: "B", since: expect.any(Number), via: [] },
			{ waiter: "D", since: expect.any(Number), via: ["B"] },
		]);
	});
});
