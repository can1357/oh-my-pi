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

describe("createAgentSession startup abort releases extension IRC state", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			await dir.remove().catch(() => {});
		}
	});

	// The runner is constructed right after extensions load and before the
	// model/provider setup window (sdk.ts). This regression pins that ordering: an
	// extension claims an IRC namespace during load, then startup aborts inside the
	// model window — the `!hasSession` catch must still fire `session_shutdown`
	// through the (already-constructed) runner and release the claim. With the
	// runner built later, `credentialDisabledTarget` was undefined at the throw and
	// the namespace/transport/proxy leaked (#7401 review).
	it("releases the namespace, transport, and remote proxy when startup throws in the model window", async () => {
		const tempDir = TempDir.createSync(`@pi-sdk-startup-abort-irc-${Snowflake.next()}-`);
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });

		const agentRegistry = new AgentRegistry();
		const transport: RemoteTransport = {
			async send(message) {
				return { to: message.to, outcome: "injected" };
			},
		};
		// Claims IRC during load (before the runner is built). The seam is
		// capability-detected (optionally typed), so guard it: a build missing it
		// throws here — surfacing as a loud setup failure, never a silent no-op that
		// would let the assertions pass for the wrong reason.
		let claimed = false;
		const ircExtension: ExtensionFactory = pi => {
			const { setRemoteTransport, registerRemotePeer } = pi.irc;
			if (!setRemoteTransport || !registerRemotePeer) {
				throw new Error("test setup: pi.irc remote-transport seam unavailable on this build");
			}
			setRemoteTransport("cluster-abort", transport);
			registerRemotePeer({ name: "alice", displayName: "alice" });
			claimed = true;
		};

		// Force the abort inside the model/provider setup window — the first awaited
		// `refreshRuntimeProviders("offline")` sits there, after the runner and before
		// the session exists, so the throw hits the pre-session (`!hasSession`) catch.
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

		// The extension's factory ran and claimed IRC before the abort.
		expect(claimed).toBe(true);
		// The aborted startup released that claim: namespace re-claimable (no surviving
		// transport) and the seeded remote proxy is gone.
		expect(IrcBus.forRegistry(agentRegistry).hasRemoteTransport()).toBe(false);
		expect(agentRegistry.get("@cluster-abort/alice")).toBeUndefined();
	});
});
