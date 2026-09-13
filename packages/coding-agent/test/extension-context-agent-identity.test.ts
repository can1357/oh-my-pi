import { describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { AgentIdentity } from "../src/extensibility/extensions/types";
import { AgentRegistry, MAIN_AGENT_ID } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { createAgentSession, type CreateAgentSessionOptions } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";

function makeRunner(identity?: AgentIdentity): ExtensionRunner {
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

async function withTestSession(
	customOptions: Partial<CreateAgentSessionOptions>,
	fn: (session: AgentSession, registry: AgentRegistry) => Promise<void>,
): Promise<void> {
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-identity-sdk-"));
	const registry = (customOptions.agentRegistry as AgentRegistry | undefined) ?? new AgentRegistry();
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
			...customOptions,
			agentRegistry: registry,
		});
		try {
			await fn(session, registry);
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
}

describe("AgentRegistry.resolveParentChain", () => {
	it("returns an empty chain for undefined parent or Main", () => {
		const registry = new AgentRegistry();
		expect(registry.resolveParentChain(undefined, "Worker")).toEqual([]);
		expect(registry.resolveParentChain(MAIN_AGENT_ID, "Worker")).toEqual([]);
	});

	it("resolves multi-level ancestor chain nearest-first and stops at Main", () => {
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		registry.register({ id: "P1", displayName: "p1", kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		registry.register({ id: "P2", displayName: "p2", kind: "sub", parentId: "P1", session: null });

		expect(registry.resolveParentChain("P2", "Worker")).toEqual(["P2", "P1"]);
		expect(registry.resolveParentChain("P1", "P2")).toEqual(["P1"]);
	});

	it("terminates on cyclic parent links and never includes the self id", () => {
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		registry.register({ id: "B", displayName: "bee", kind: "sub", parentId: "A", session: null });
		registry.register({ id: "A", displayName: "ay", kind: "sub", parentId: "B", session: null });

		// For A: parent is B, B's parent is A (self) -> loop terminates, chain is ["B"]
		expect(registry.resolveParentChain("B", "A")).toEqual(["B"]);
		// For B: parent is A, A's parent is B (self) -> loop terminates, chain is ["A"]
		expect(registry.resolveParentChain("A", "B")).toEqual(["A"]);
	});

	it("handles a self-referential parent without infinite loop", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "SelfLoop", displayName: "self", kind: "sub", parentId: "SelfLoop", session: null });

		expect(registry.resolveParentChain("SelfLoop", "SelfLoop")).toEqual([]);
	});

	it("stops when a parent link is missing from the registry", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "P1", displayName: "p1", kind: "sub", parentId: "MissingParent", session: null });

		expect(registry.resolveParentChain("P1", "Worker")).toEqual(["P1", "MissingParent"]);
	});
});

describe("ExtensionContext agentIdentity", () => {
	it("reports undefined identity when constructed without one (no fabricated Main)", () => {
		const runner = makeRunner();

		expect(runner.createContext().agentIdentity).toBeUndefined();
	});

	it("omits the parentId key for a top-level session", () => {
		const identity = makeRunner({
			kind: "main",
			depth: 0,
			agentId: MAIN_AGENT_ID,
			displayName: "Main",
			parentChain: [],
		}).createContext().agentIdentity;

		expect(identity).toEqual({
			kind: "main",
			depth: 0,
			agentId: MAIN_AGENT_ID,
			displayName: "Main",
			parentChain: [],
		});
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
		const registry = new AgentRegistry();
		registry.register({ id: "P1", displayName: "planner", kind: "sub", parentId: MAIN_AGENT_ID, session: null });

		await withTestSession(
			{
				agentRegistry: registry,
				agentId: "C1",
				parentAgentId: "P1",
			},
			async session => {
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
			},
		);
	});

	it("reports the documented /tan fork identity through the public SDK path", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });

		await withTestSession(
			{
				agentRegistry: registry,
				agentId: "Tan-1",
				agentDisplayName: "tan",
				parentTaskPrefix: "Tan-1",
				parentAgentId: MAIN_AGENT_ID,
			},
			async session => {
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
			},
		);
	});

	it("walks a cyclic agent registry to termination, self-exclusion, and nearest-first order through the public SDK path", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		registry.register({ id: "B", displayName: "bee", kind: "sub", parentId: "A", session: null });
		registry.register({ id: "A", displayName: "ay", kind: "sub", parentId: "B", session: null });

		await withTestSession(
			{
				agentRegistry: registry,
				agentId: "A",
				parentAgentId: "B",
			},
			async session => {
				const identity = session.extensionRunner?.createContext().agentIdentity;
				// A's parent chain: B (parent), then B's parent A — the agent's own
				// id, already seeded into `seen`, so the cycle terminates and A
				// never appears in its own ancestry.
				expect(identity?.agentId).toBe("A");
				expect(identity?.parentId).toBe("B");
				expect(identity?.parentChain).toEqual(["B"]);
			},
		);
	});

	it("reports a task-subagent identity for an ordinary taskDepth spawn through the public SDK path", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });

		await withTestSession(
			{
				agentRegistry: registry,
				agentId: "S1",
				agentDisplayName: "researcher",
				parentAgentId: MAIN_AGENT_ID,
				taskDepth: 1,
			},
			async session => {
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
			},
		);
	});
});
