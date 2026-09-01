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
	it("reports undefined identity when constructed without one (no fabricated Main)", () => {
		const runner = makeRunner();

		expect(runner.createContext().agentIdentity).toBeUndefined();
	});

	it("resolves deeper ancestors from the registry at first access and never re-queries after", () => {
		const registry = new AgentRegistry();
		// Direct parent `P1` is snapshotted from the constructor input; only its
		// own ancestor would come from a registry lookup (none registered yet).
		const runner = makeRunner({ kind: "sub", depth: 2, agentId: "C2", displayName: "c2", parentId: "P1", registry });

		expect(runner.createContext().agentIdentity?.parentChain).toEqual(["P1"]);

		// Registering P1's own parent afterwards does not retro-link the
		// memoized identity — the chain is resolved once (structural for a live
		// agent), not re-queried on every access.
		registry.register({ id: "P1", displayName: "planner", kind: "sub", parentId: "GP", session: null });
		registry.register({ id: "GP", displayName: "grand", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		expect(runner.createContext().agentIdentity?.parentChain).toEqual(["P1"]);
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

	it("snapshots the chain at first access so registry unregistration or replacement never rewrites it", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "P1", displayName: "planner", kind: "sub", parentId: "GP", session: null });
		registry.register({ id: "GP", displayName: "grandparent", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		registry.register({ id: "C1", displayName: "worker", kind: "sub", parentId: "P1", session: null });
		const runner = makeRunner({
			kind: "sub",
			depth: 2,
			agentId: "C1",
			displayName: "worker",
			parentId: "P1",
			registry,
		});

		const before = runner.createContext().agentIdentity;
		expect(before?.parentChain).toEqual(["P1", "GP"]);

		// Unregistering an ancestor truncates nothing in the already-snapshotted
		// chain; re-registering the same id with different ancestry splices in
		// nothing either. One stable identity per session regardless of when
		// handlers first read `ctx.agentIdentity`.
		registry.unregister("GP");
		registry.unregister("P1");
		registry.register({ id: "P1", displayName: "imposter", kind: "sub", parentId: "EVIL", session: null });
		registry.register({ id: "EVIL", displayName: "evil", kind: "sub", parentId: "P1", session: null });
		const after = runner.createContext().agentIdentity;
		expect(after?.parentChain).toEqual(["P1", "GP"]);
		expect(before?.parentChain).toEqual(["P1", "GP"]);
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

		expect(identity?.parentId).toBe("P1");
		expect(identity?.depth).toBe(2);
		expect(identity?.parentChain).toEqual(["P1"]);
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
		expect(identity?.parentChain).toEqual(["B"]);
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
		expect(identity?.parentChain).toEqual(["P2", "P1"]);
		// A mutation attempt must not corrupt the identity other handlers read
		// (frozen surfaces may not throw in every runtime, but must never change).
		if (identity) {
			expect(Object.isFrozen(identity)).toBe(true);
			expect(Object.isFrozen(identity.parentChain)).toBe(true);
			try {
				(identity.parentChain as unknown as string[]).reverse();
			} catch {
				// Frozen-array mutation may throw depending on runtime — both outcomes fine.
			}
		}
		expect(runner.createContext().agentIdentity?.parentChain).toEqual(["P2", "P1"]);
	});

	it("classifies a parentAgentId-only SDK caller by the pre-existing gate inputs (additive)", async () => {
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
				// Identity strictly observes the pre-existing classification
				// (`taskDepth > 0 || parentTaskPrefix`): a parentAgentId-only
				// caller is "main", exactly as on main before this feature.
				// The linkage itself is still reported via parent fields.
				expect(identity?.kind).toBe("main");
				expect(identity?.parentId).toBe("P1");
				expect(identity?.parentChain).toEqual(["P1"]);
				// Registry registration keeps the pre-PR classification too.
				expect(registry.get("C1")?.kind).toBe("main");
				expect(registry.get("C1")?.displayName).toBe("main");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
			await fsp.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("reports the documented /tan fork identity through the public SDK path", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-identity-sdk-tan-"));
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		const authStorage = await AuthStorage.create(":memory:");
		try {
			// Options mirror TanCommandController.start(): parentTaskPrefix is
			// always truthy, taskDepth is never set, the owning main session is
			// the parentAgentId.
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
				agentId: "Tan-1",
				agentDisplayName: "tan",
				parentTaskPrefix: "Tan-1",
				parentAgentId: MAIN_AGENT_ID,
			});
			try {
				const identity = session.extensionRunner?.createContext().agentIdentity;
				// Documented special tan-fork identity: classified "sub" by the
				// pre-existing parentTaskPrefix input, depth 0 (no taskDepth),
				// parentChain empty (walk stops at "Main").
				expect(identity).toEqual({
					kind: "sub",
					depth: 0,
					agentId: "Tan-1",
					displayName: "tan",
					parentId: MAIN_AGENT_ID,
					parentChain: [],
				});
				expect(registry.get("Tan-1")?.kind).toBe("sub");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
			await fsp.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("reports a task-subagent identity for an ordinary taskDepth spawn through the public SDK path", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-identity-sdk-depth-"));
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		const authStorage = await AuthStorage.create(":memory:");
		try {
			// The ordinary executor subagent shape: taskDepth > 0 supplied
			// without parentTaskPrefix, so only the taskDepth gate marks it.
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
				agentId: "S1",
				agentDisplayName: "researcher",
				parentAgentId: MAIN_AGENT_ID,
				taskDepth: 1,
			});
			try {
				const identity = session.extensionRunner?.createContext().agentIdentity;
				expect(identity).toEqual({
					kind: "sub",
					depth: 1,
					agentId: "S1",
					displayName: "researcher",
					parentId: MAIN_AGENT_ID,
					parentChain: [],
				});
				expect(registry.get("S1")?.kind).toBe("sub");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
			await fsp.rm(tempDir, { recursive: true, force: true });
		}
	});
});
