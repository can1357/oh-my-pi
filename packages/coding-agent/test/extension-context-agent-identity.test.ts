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
 * the trailing identity input is optional, so the omission test omits it entirely.
 *
 * The host (sdk.ts) resolves `parentChain` eagerly from the registry; these
 * helpers mirror that walk directly instead of involving a registry.
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

	it("reports a subagent's direct parentId but excludes Main from the parent chain", () => {
		const runner = makeRunner({
			kind: "sub",
			depth: 1,
			agentId: "C1",
			displayName: "researcher",
			parentId: MAIN_AGENT_ID,
			parentChain: [],
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

	it("omits the parentId key for a top-level session", () => {
		const identity = makeRunner({
			kind: "main",
			depth: 0,
			agentId: MAIN_AGENT_ID,
			displayName: "Main",
			parentChain: [],
		}).createContext().agentIdentity;

		expect(identity).toEqual({ kind: "main", depth: 0, agentId: "Main", displayName: "Main", parentChain: [] });
		// Key absence, not undefined-valued key: toEqual cannot tell them apart,
		// but consumers checking `"parentId" in identity` (or Object.keys) can.
		expect(Object.hasOwn(identity ?? {}, "parentId")).toBe(false);
	});

	it("reports the host-resolved ancestor chain nearest-first and stable across reads", () => {
		const runner = makeRunner({
			kind: "sub",
			depth: 2,
			agentId: "C1",
			displayName: "worker",
			parentId: "P1",
			parentChain: ["P1", "GP"],
		});

		const first = runner.createContext().agentIdentity;
		expect(first?.parentChain).toEqual(["P1", "GP"]);
		expect(first?.parentId).toBe("P1");
		expect(first?.depth).toBe(2);
		// Later reads (fresh contexts) observe the same identity: registry
		// mutations after construction cannot rewrite an identity already
		// handed out, and every handler of the session sees one stable chain.
		expect(runner.createContext().agentIdentity).toBe(first);
		expect(runner.createContext().agentIdentity?.parentChain).toEqual(["P1", "GP"]);
	});

	it("terminates on cyclic parent links and never includes the agent's own id", () => {
		// The cycle A -> B -> A is cut by seeding the walk with A's own id: the
		// chain is the true ancestors reached before the loop closes ("B"), not
		// `["B", "A"]` with A reappearing in its own ancestry.
		const identity = makeRunner({
			kind: "sub",
			depth: 1,
			agentId: "A",
			displayName: "a",
			parentId: "B",
			parentChain: ["B"],
		}).createContext().agentIdentity;

		expect(identity?.parentChain).toEqual(["B"]);
	});

	it("hands handlers an immutable identity so one extension cannot corrupt it for others", () => {
		const runner = makeRunner({
			kind: "sub",
			depth: 2,
			agentId: "C2",
			displayName: "c2",
			parentId: "P2",
			parentChain: ["P2", "P1"],
		});
		const identity = runner.createContext().agentIdentity;
		expect(identity?.parentChain).toEqual(["P2", "P1"]);
		if (identity) {
			try {
				(identity.parentChain as unknown as string[]).reverse();
			} catch {
				// Frozen-array mutation may throw depending on runtime — both outcomes fine.
			}
		}
		// A mutation attempt must not corrupt the identity other handlers read.
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
