import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

const getModel = () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	return model;
};

const emptyWorkspaceTree = (cwd: string): WorkspaceTree => ({
	rootPath: cwd,
	rendered: ".",
	truncated: false,
	totalLines: 1,
	agentsMdFiles: [],
});

const okTransport = (): RemoteTransport => ({
	async send(message) {
		return { to: message.to, outcome: "injected" };
	},
});

// Claim an IRC namespace from inside an extension factory. The seam is
// capability-detected (optionally typed), so guard it: a build missing it throws
// here — surfacing as a loud setup failure, never a silent no-op that would let an
// assertion pass for the wrong reason.
const claimNamespace = (
	pi: Parameters<ExtensionFactory>[0],
	namespace: string,
	transport: RemoteTransport,
	peer?: string,
): void => {
	const { setRemoteTransport, registerRemotePeer } = pi.irc;
	if (!setRemoteTransport || !registerRemotePeer) {
		throw new Error("test setup: pi.irc remote-transport seam unavailable on this build");
	}
	setRemoteTransport(namespace, transport);
	if (peer) registerRemotePeer({ name: peer, displayName: peer });
};

describe("createAgentSession + extension IRC (murmur bridge)", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			await dir.remove().catch(() => {});
		}
	});

	const makeProject = () => {
		const tempDir = TempDir.createSync(`@pi-sdk-irc-extension-${Snowflake.next()}-`);
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		return { cwd, agentDir };
	};

	// The runner is constructed before the inline-factory loop AND the model/provider
	// window, and recorded as the startup-abort shutdown owner. These two aborts pin
	// that ordering: a claim made during load must be released when startup later
	// throws, or the namespace/transport/proxy leak onto a registry that outlives the
	// dead session (#7401 review).

	it("releases the claim when startup throws in the model/provider window", async () => {
		const { cwd, agentDir } = makeProject();
		const agentRegistry = new AgentRegistry();
		let claimed = false;
		const ircExtension: ExtensionFactory = pi => {
			claimNamespace(pi, "cluster-abort", okTransport(), "alice");
			claimed = true;
		};

		// The first awaited `refreshRuntimeProviders("offline")` sits in the model window,
		// after the runner and before the session exists — so its throw hits the
		// pre-session (`!hasSession`) catch.
		vi.spyOn(ModelRegistry.prototype, "refreshRuntimeProviders").mockRejectedValue(
			new Error("runtime discovery failed"),
		);

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated({}),
				model: getModel(),
				disableExtensionDiscovery: true,
				extensions: [ircExtension],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["eval"],
				workspaceTree: emptyWorkspaceTree(cwd),
				agentRegistry,
			}),
		).rejects.toThrow("runtime discovery failed");

		expect(claimed).toBe(true);
		expect(IrcBus.forRegistry(agentRegistry).hasRemoteTransport()).toBe(false);
		expect(agentRegistry.get("@cluster-abort/alice")).toBeUndefined();
	});

	it("releases an earlier inline extension's claim when a later inline factory throws", async () => {
		const { cwd, agentDir } = makeProject();
		const agentRegistry = new AgentRegistry();
		let firstClaimed = false;
		// Inline factory #0 claims a namespace and succeeds; #1 throws. The abort comes
		// from the inline loop itself — before the model window — so it exercises the
		// window the runner-below-the-loop placement used to leak.
		const claimer: ExtensionFactory = pi => {
			claimNamespace(pi, "cluster-inline", okTransport(), "alice");
			firstClaimed = true;
		};
		const thrower: ExtensionFactory = () => {
			throw new Error("second inline factory failed");
		};

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated({}),
				model: getModel(),
				disableExtensionDiscovery: true,
				extensions: [claimer, thrower],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["eval"],
				workspaceTree: emptyWorkspaceTree(cwd),
				agentRegistry,
			}),
		).rejects.toThrow("second inline factory failed");

		expect(firstClaimed).toBe(true);
		expect(IrcBus.forRegistry(agentRegistry).hasRemoteTransport()).toBe(false);
		expect(agentRegistry.get("@cluster-inline/alice")).toBeUndefined();
	});

	// createTools() builds the built-in slate before extensions load, so a bridge that
	// installs its RemoteTransport during load was invisible to the hub gate. For a
	// leaf root (task.maxRecursionDepth=0, no spawn-based peers) that dropped `hub`
	// entirely. It must be re-added once the transport is claimed (#7401 review).
	it("adds the hub tool for a leaf root once a bridge installs a transport", async () => {
		const { cwd, agentDir } = makeProject();
		const agentRegistry = new AgentRegistry();
		const bridge: ExtensionFactory = pi => {
			claimNamespace(pi, "cluster-leaf", okTransport(), "alice");
		};

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			// Leaf root: cannot spawn subagents, so peers exist only via the bridge transport.
			settings: Settings.isolated({ "task.maxRecursionDepth": 0 }),
			model: getModel(),
			disableExtensionDiscovery: true,
			extensions: [bridge],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			workspaceTree: emptyWorkspaceTree(cwd),
			agentRegistry,
		});
		try {
			expect(IrcBus.forRegistry(agentRegistry).hasRemoteTransport()).toBe(true);
			// The bridge is a leaf root (no `task`), yet `hub` is active because a transport
			// was claimed during load — matching the prompt block that advertises the peers.
			const activeTools = session.getActiveToolNames();
			expect(activeTools).toContain("hub");
			expect(activeTools).not.toContain("task");
		} finally {
			await session.dispose();
		}
	});
});
