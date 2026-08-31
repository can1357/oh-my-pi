import { describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRunner, type ExtensionRunnerIdentityInput } from "../src/extensibility/extensions/runner";
import { AgentRegistry, MAIN_AGENT_ID } from "../src/registry/agent-registry";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";

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

	it("memoizes the identity: the same frozen object is served on every access", () => {
		const registry = new AgentRegistry();
		const runner = makeRunner({ kind: "main", depth: 0, agentId: MAIN_AGENT_ID, displayName: "main", registry });

		const first = runner.createContext().agentIdentity;
		const second = runner.createContext().agentIdentity;
		// The memoized identity is shared across handlers by contract: every
		// consumer must observe the one frozen instance, not a fresh copy.
		expect(second).toBe(first);
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

	it("terminates on cyclic parent links and never includes the agent's own id", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "A", displayName: "a", kind: "sub", parentId: "B", session: null });
		registry.register({ id: "B", displayName: "b", kind: "sub", parentId: "A", session: null });
		const identity = makeRunner({
			kind: "sub",
			depth: 1,
			agentId: "A",
			displayName: "a",
			parentId: "B",
			registry,
		}).createContext().agentIdentity;

		// The cycle A -> B -> A is cut by seeding the walk with A's own id: the
		// chain is the true ancestors reached before the loop closes ("B"), not
		// `["B", "A"]` with A reappearing in its own ancestry.
		expect(identity.parentChain).toEqual(["B"]);
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

	it("derives a parentAgentId-only SDK caller as a consistent sub identity", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-identity-sdk-link-"));
		const registry = new AgentRegistry();
		registry.register({ id: "P1", displayName: "planner", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const { session } = await createAgentSession({
				cwd: path.join(tempDir, "project"),
				agentDir: path.join(tempDir, "agent"),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: [],
				enableMCP: false,
				enableLsp: false,
				agentRegistry: registry,
				agentId: "C1",
				parentAgentId: "P1",
			});
			try {
				const identity = session.extensionRunner?.createContext().agentIdentity;
				// kind is derived from ANY parent linkage, so a parentAgentId-only
				// caller is a sub with a parent — never main-with-parent.
				expect(identity?.kind).toBe("sub");
				expect(identity?.parentId).toBe("P1");
				expect(identity?.parentChain).toEqual(["P1"]);
				expect(registry.get("C1")?.kind).toBe("sub");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
			await fsp.rm(tempDir, { recursive: true, force: true });
		}
	});
});
