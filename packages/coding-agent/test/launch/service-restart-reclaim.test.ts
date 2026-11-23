// Integration tests: a real daemon in a private runtime dir (see test/fixtures/daemon-harness.ts).
// An in-place `/restart` is modeled the way the daemon sees it: the old process's connection drops
// and a new process resumes the same session id with a fresh connection and no lease.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import { ModelRegistry } from "../../src/config/model-registry";
import { closeDaemonClient, probeDaemon } from "../../src/daemon/client";
import { DAEMON_RESUME_LEASE_GRACE_ENV, type UnitSnapshot } from "../../src/daemon/protocol";
import { Settings } from "../../src/config/settings";
import { reclaimServices, startService } from "../../src/launch/services";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { IsolatedDaemon, isAlive, waitFor } from "../fixtures/daemon-harness";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/** Reconnect lease grace of the spawned daemon; long enough to observe, short enough to wait out. */
const LEASE_GRACE_MS = 750;
/** Grace for the SDK case: building a whole agent session takes longer than {@link LEASE_GRACE_MS}. */
const SDK_LEASE_GRACE_MS = 5_000;

let harness: IsolatedDaemon;
let previousGrace: string | undefined;

beforeEach(async () => {
	previousGrace = process.env[DAEMON_RESUME_LEASE_GRACE_ENV];
	process.env[DAEMON_RESUME_LEASE_GRACE_ENV] = String(LEASE_GRACE_MS);
	harness = await IsolatedDaemon.create();
});

afterEach(async () => {
	try {
		await harness.dispose();
	} finally {
		if (previousGrace === undefined) delete process.env[DAEMON_RESUME_LEASE_GRACE_ENV];
		else process.env[DAEMON_RESUME_LEASE_GRACE_ENV] = previousGrace;
	}
});

/** The parts of a tool session the named-service path reads: its project, settings, and session id. */
function toolSession(cwd: string, sessionId: string): ToolSession {
	return {
		cwd,
		settings: Settings.isolated(),
		getSessionId: () => sessionId,
	} as unknown as ToolSession;
}

/** The service unit `name` as a fresh, lease-free connection sees it. */
async function observe(name: string): Promise<UnitSnapshot | undefined> {
	const probe = await probeDaemon();
	if (!probe) return undefined;
	try {
		const { units } = await probe.request({ op: "list", kind: "proc" });
		return units.find(unit => unit.key === name);
	} finally {
		probe.close();
	}
}

/** Start `name` as session `sessionId`, then drop the connection the way an exiting process does. */
async function startThenExit(cwd: string, sessionId: string, name: string): Promise<UnitSnapshot> {
	const { daemon } = await startService(toolSession(cwd, sessionId), { name, command: "exec sleep 60", pty: false });
	harness.track(...daemon.pids);
	expect(daemon.policy.hold).toBe("leases");
	await closeDaemonClient();
	return daemon;
}

describe("named services across an in-place restart", () => {
	it("the resumed session reclaims its service, which outlives the reconnect grace and stays session-scoped", async () => {
		const cwd = await fs.mkdtemp(path.join(harness.dir, "proj-"));
		const started = await startThenExit(cwd, "session-a", "web");
		const pid = started.pids[0]!;

		const resumed = toolSession(cwd, "session-a");
		await reclaimServices(resumed);
		await Bun.sleep(LEASE_GRACE_MS * 3);

		const unit = await observe("web");
		expect(unit?.id).toBe(started.id);
		expect(unit?.pids[0]).toBe(pid);
		expect(TERMINAL_STATES[unit!.state]).toBeFalsy();
		expect(unit?.leases).toBe(1);
		expect(unit?.policy.hold).toBe("leases");
		expect(isAlive(pid)).toBe(true);

		// It is still session-scoped: the resumed process exiting for good stops it after the grace.
		await closeDaemonClient();
		await waitFor(async () => !isAlive(pid), "the unclaimed service to stop", 10_000);
	}, 60_000);

	it("resuming the session file through the SDK, as a restart does, keeps the service the old process started", async () => {
		process.env[DAEMON_RESUME_LEASE_GRACE_ENV] = String(SDK_LEASE_GRACE_MS);
		const cwd = await fs.mkdtemp(path.join(harness.dir, "proj-"));
		const writer = SessionManager.create(cwd, cwd);
		writer.appendMessage({ role: "user", content: "serve the review page", timestamp: Date.now() });
		writer.appendMessage(createAssistantMessage("started web"));
		await writer.flush();
		const sessionFile = writer.getSessionFile()!;
		const started = await startThenExit(cwd, writer.getSessionId(), "web");
		const pid = started.pids[0]!;

		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: await SessionManager.open(sessionFile),
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			expect(session.sessionManager.getSessionId()).toBe(writer.getSessionId());
			await waitFor(async () => (await observe("web"))?.leases === 1, "the resumed session to reclaim the service");
			await Bun.sleep(SDK_LEASE_GRACE_MS + 1_000);
			expect((await observe("web"))?.pids[0]).toBe(pid);
			expect(isAlive(pid)).toBe(true);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}, 60_000);

	it("reclaims a service in the project it started in after the session moved elsewhere", async () => {
		const started = await startThenExit(await fs.mkdtemp(path.join(harness.dir, "proj-")), "session-a", "web");
		const moved = toolSession(await fs.mkdtemp(path.join(harness.dir, "moved-")), "session-a");
		await reclaimServices(moved);
		await Bun.sleep(LEASE_GRACE_MS * 3);
		expect((await observe("web"))?.leases).toBe(1);
		expect(isAlive(started.pids[0]!)).toBe(true);
	}, 60_000);

	it("a session disposed before the reclaim lands takes no lease", async () => {
		const cwd = await fs.mkdtemp(path.join(harness.dir, "proj-"));
		const started = await startThenExit(cwd, "session-a", "web");
		const disposed = {
			...toolSession(cwd, "session-a"),
			registerDisposeCallback: (callback: () => void) => callback(),
		} as unknown as ToolSession;
		await reclaimServices(disposed);
		await waitFor(async () => !isAlive(started.pids[0]!), "the unclaimed service to stop", 10_000);
	}, 60_000);

	it("a service nobody reclaims stops once the reconnect grace ends, and another session does not claim it", async () => {
		const cwd = await fs.mkdtemp(path.join(harness.dir, "proj-"));
		const started = await startThenExit(cwd, "session-a", "web");
		const pid = started.pids[0]!;

		await reclaimServices(toolSession(cwd, "session-b"));
		await waitFor(async () => !isAlive(pid), "the unclaimed service to stop", 10_000);
		const unit = await observe("web");
		expect(unit === undefined || TERMINAL_STATES[unit.state]).toBeTruthy();
	}, 60_000);

	it("starts no daemon when none runs", async () => {
		const cwd = await fs.mkdtemp(path.join(harness.dir, "proj-"));
		await reclaimServices(toolSession(cwd, "session-a"));
		expect(await probeDaemon()).toBeUndefined();
	}, 30_000);
});
