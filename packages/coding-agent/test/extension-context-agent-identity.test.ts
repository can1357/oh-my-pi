import { describe, expect, it } from "bun:test";
import { ExtensionRunner, type ExtensionRunnerIdentityInput } from "../src/extensibility/extensions/runner";
import { AgentRegistry, MAIN_AGENT_ID } from "../src/registry/agent-registry";

/**
 * Minimal construction matching test/extension-context-async-jobs.test.ts;
 * the trailing identity input is optional, so the fallback test omits it entirely.
 */
function makeRunner(identity?: ExtensionRunnerIdentityInput): ExtensionRunner {
	return new ExtensionRunner(
		[],
		{} as never,
		"/tmp",
		{ getCwd: () => "/tmp" } as never,
		{} as never,
		undefined,
		undefined,
		undefined,
		undefined,
		identity,
	);
}

describe("ExtensionContext agentIdentity", () => {
	it("falls back to the top-level main identity when constructed without one", () => {
		const runner = makeRunner();

		expect(runner.createContext().agentIdentity).toEqual({
			kind: "main",
			depth: 0,
			agentId: MAIN_AGENT_ID,
			displayName: "main",
			parentChain: [],
		});
	});

	it("passes a provided main identity through with an empty parent chain", () => {
		const registry = new AgentRegistry();
		const runner = makeRunner({ kind: "main", depth: 0, agentId: MAIN_AGENT_ID, displayName: "main", registry });

		expect(runner.createContext().agentIdentity).toEqual({
			kind: "main",
			depth: 0,
			agentId: MAIN_AGENT_ID,
			displayName: "main",
			parentChain: [],
		});
	});

	it("reports a subagent's direct parentId but excludes Main from the parent chain", () => {
		const registry = new AgentRegistry();
		const runner = makeRunner({
			kind: "sub",
			depth: 1,
			agentId: "C1",
			displayName: "researcher",
			parentId: MAIN_AGENT_ID,
			registry,
		});

		expect(runner.createContext().agentIdentity).toEqual({
			kind: "sub",
			depth: 1,
			agentId: "C1",
			displayName: "researcher",
			parentId: MAIN_AGENT_ID,
			parentChain: [],
		});
	});

	it("resolves the ancestor chain nearest-first through registry parent links, excluding Main", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "P1", displayName: "planner", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		registry.register({ id: "C2", displayName: "worker", kind: "sub", parentId: "P1", session: null });
		const identity = makeRunner({
			kind: "sub",
			depth: 2,
			agentId: "C2",
			displayName: "worker",
			parentId: "P1",
			registry,
		}).createContext().agentIdentity;

		expect(identity.parentId).toBe("P1");
		expect(identity.depth).toBe(2);
		expect(identity.parentChain).toEqual(["P1"]);
	});

	it("terminates on cyclic parent links instead of walking forever", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "A", displayName: "a", kind: "sub", parentId: "B", session: null });
		registry.register({ id: "B", displayName: "b", kind: "sub", parentId: "A", session: null });
		const chain = makeRunner({
			kind: "sub",
			depth: 1,
			agentId: "A",
			displayName: "a",
			parentId: "B",
			registry,
		}).createContext().agentIdentity.parentChain;

		expect(chain.length).toBeLessThanOrEqual(2);
	});

	it("hands handlers an immutable identity so one extension cannot corrupt it for others", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "P1", displayName: "p1", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		registry.register({ id: "P2", displayName: "p2", kind: "sub", parentId: "P1", session: null });
		const runner = makeRunner({
			kind: "sub",
			depth: 2,
			agentId: "C2",
			displayName: "c2",
			parentId: "P2",
			registry,
		});
		const identity = runner.createContext().agentIdentity;
		expect(identity.parentChain).toEqual(["P2", "P1"]);

		expect(Object.isFrozen(identity)).toBe(true);
		expect(Object.isFrozen(identity.parentChain)).toBe(true);
		// A mutation attempt must not corrupt the identity other handlers read
		// (frozen surfaces may not throw in every runtime, but must never change).
		try {
			(identity.parentChain as unknown as string[]).reverse();
		} catch {
			// Frozen-array mutation may throw depending on runtime — both outcomes fine.
		}
		expect(runner.createContext().agentIdentity.parentChain).toEqual(["P2", "P1"]);
	});
});
