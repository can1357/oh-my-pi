/**
 * Regression (#17945): the process-global agent registry keeps an earlier
 * session's subagents after `/new` or a session switch, but the Agent Hub
 * roster only lists the current session's tree.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type AgentHubRemote, AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

describe("Agent Hub session scope", () => {
	let dir: string;
	const hubs: AgentHubOverlayComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(async () => {
		for (const hub of hubs.splice(0)) hub.dispose();
		AgentRegistry.resetGlobalForTests();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	/** Render a hub opened on the new session while the registry still holds the old one's tree. */
	async function renderHub(remote?: AgentHubRemote): Promise<string> {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hub-scope-"));
		const oldRoot = path.join(dir, "old.jsonl");
		const newRoot = path.join(dir, "new.jsonl");
		await Bun.write(oldRoot, "");
		await Bun.write(newRoot, "");
		const registry = new AgentRegistry();
		registry.register({
			id: "OldParked",
			displayName: "OldParked",
			kind: "sub",
			session: null,
			status: "parked",
			sessionFile: path.join(dir, "old", "OldParked.jsonl"),
		});
		registry.register({
			id: "OldNested",
			displayName: "OldNested",
			kind: "sub",
			parentId: "OldParked",
			session: null,
			status: "parked",
			sessionFile: path.join(dir, "old", "OldParked", "OldNested.jsonl"),
		});
		registry.register({
			id: "NewLive",
			displayName: "NewLive",
			kind: "sub",
			session: {} as AgentSession,
			sessionFile: path.join(dir, "new", "NewLive.jsonl"),
		});
		registry.register({ id: "Memory", displayName: "Memory", kind: "sub", session: {} as AgentSession });
		const hub = new AgentHubOverlayComponent({
			...createAgentHubRuntime({ settings: Settings.isolated(), registry, remote, sessionFile: newRoot }),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			irc: new IrcBus(registry),
			remote,
			sessionFile: newRoot,
		});
		hubs.push(hub);
		return Bun.stripANSI(hub.render(120).join("\n"));
	}

	it("hides subagents persisted under a previous session's root", async () => {
		const text = await renderHub();
		expect(text).toContain("NewLive");
		expect(text).toContain("Memory");
		expect(text).not.toContain("OldParked");
		expect(text).not.toContain("OldNested");
	});

	it("keeps the host's full roster for a collab guest", async () => {
		const remote: AgentHubRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async () => null,
		};
		const text = await renderHub(remote);
		for (const id of ["NewLive", "Memory", "OldParked", "OldNested"]) expect(text).toContain(id);
	});
});
