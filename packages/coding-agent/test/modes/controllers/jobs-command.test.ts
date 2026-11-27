import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createModeTerminal, type ModeTerminal } from "../../helpers/mode-terminal";

/** Whether `node` is `root` or inside it. */
function within(root: UiNode, node: UiNode | null): boolean {
	return node !== null && (root === node || root.children().some(child => within(child, node)));
}

describe("/jobs in the native terminal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal;
	/** Whether the shell reports a native (Tern) surface: `/jobs` opens the live sheet there. */
	let native: boolean;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-jobs-native-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			asyncJobManager: manager,
			agentId: "main",
		});
		// The sheet and reports run on the shell: keys reach them through the terminal.
		term = createModeTerminal({ columns: 120, rows: 40 });
		await term.start();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
		mode.isInitialized = true;
		native = true;
		vi.spyOn(mode.shell, "native").mockImplementation(() => native);
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		HistoryStorage.close();
		vi.restoreAllMocks();
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 1_000 });
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("opens the live jobs sheet listing the running job, leaves the transcript alone, and Esc closes it", async () => {
		const gate = Promise.withResolvers<string>();
		manager.register("bash", "cargo test --workspace", () => gate.promise, { ownerId: "main" });
		const transcript = [...mode.shell.transcript.blocks()];

		await mode.handleJobsCommand();

		const sheet = mode.shell.overlays.top();
		expect(sheet).toBeDefined();
		expect(sheet && within(sheet.node, mode.shell.focused())).toBe(true);
		await term.waitFor(screen => screen.join("\n").includes("cargo test --workspace"));
		expect(mode.shell.transcript.blocks()).toEqual(transcript);

		term.press("escape");
		await term.waitFor(() => !mode.shell.overlays.open());
		expect(mode.shell.transcript.blocks()).toEqual(transcript);
		gate.resolve("done");
	});

	it("`/jobs kill <id>` cancels the running job through the TUI dispatcher", async () => {
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "sleep 999", () => gate.promise, { ownerId: "main" });
		const showStatus = vi.spyOn(mode, "showStatus");

		const handled = await executeBuiltinSlashCommand(`/jobs kill ${id}`, { ctx: mode });

		expect(handled).toBe(true);
		expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
		expect(showStatus).toHaveBeenCalledWith(`Cancelled background job ${id}.`);
		gate.resolve("done");
	});

	it("`/jobs kill all` cancels every running job", async () => {
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		const ids = gates.map((gate, index) =>
			manager.register("bash", `job-${index}`, () => gate.promise, { ownerId: "main" }),
		);

		const handled = await executeBuiltinSlashCommand("/jobs kill all", { ctx: mode });

		expect(handled).toBe(true);
		for (const id of ids) expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
		for (const gate of gates) gate.resolve("done");
	});

	it("`/jobs kill <bogus>` reports the miss without cancelling", async () => {
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "sleep 999", () => gate.promise, { ownerId: "main" });
		const showStatus = vi.spyOn(mode, "showStatus");

		await executeBuiltinSlashCommand("/jobs kill nope", { ctx: mode });

		expect(manager.getJob(id)?.status).toBe("running");
		expect(showStatus).toHaveBeenCalledWith('No running background job with id "nope".');
		gate.resolve("done");
	});

	it("`/jobs kill all` leaves a job owned by another session running", async () => {
		const ownedGate = Promise.withResolvers<string>();
		const foreignGate = Promise.withResolvers<string>();
		const ownedId = manager.register("bash", "mine", () => ownedGate.promise, { ownerId: "main" });
		const foreignId = manager.register("bash", "theirs", () => foreignGate.promise, { ownerId: "other" });

		const handled = await executeBuiltinSlashCommand("/jobs kill all", { ctx: mode });

		expect(handled).toBe(true);
		expect(manager.getJob(ownedId)?.status).toBe("cancelled");
		expect(manager.getJob(foreignId)?.status).toBe("running");
		ownedGate.resolve("done");
		foreignGate.resolve("done");
	});

	it("`/jobs kill <id>` refuses a job owned by another session", async () => {
		const foreignGate = Promise.withResolvers<string>();
		const foreignId = manager.register("bash", "theirs", () => foreignGate.promise, { ownerId: "other" });
		const showStatus = vi.spyOn(mode, "showStatus");

		await executeBuiltinSlashCommand(`/jobs kill ${foreignId}`, { ctx: mode });

		expect(manager.getJob(foreignId)?.status).toBe("running");
		expect(showStatus).toHaveBeenCalledWith(`No running background job with id "${foreignId}".`);
		foreignGate.resolve("done");
	});

	// #14814: a subagent's jobs are owned by it, so main's owner-scoped snapshot never lists them.
	it("a focused subagent view lists that agent's jobs, not main's, and offers no way to cancel them", async () => {
		const worker = new AgentSession({
			agent: new Agent({ initialState: { model: session.model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: session.modelRegistry,
			asyncJobManager: manager,
			agentId: "Worker",
		});
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		manager.register("bash", "main-only build", () => gates[0].promise, { ownerId: "main" });
		const workerJob = manager.register("bash", "worker cargo test", () => gates[1].promise, { ownerId: "Worker" });
		Object.defineProperty(mode, "viewSession", { get: () => worker, configurable: true });
		Object.defineProperty(mode, "focusedAgentId", { get: () => "Worker", configurable: true });
		try {
			await mode.handleJobsCommand();
			expect(mode.shell.overlays.open()).toBe(true);
			await term.waitFor(screen => screen.join("\n").includes("worker cargo test"));
			expect(term.screen().join("\n")).not.toContain("main-only build");
			// The cancel key does nothing: a focused subagent's sheet has no cancel action.
			term.press("x");
			await term.settle();
			expect(manager.getJob(workerJob)?.status).toBe("running");
			term.press("escape");
			await term.waitFor(() => !mode.shell.overlays.open());

			native = false;
			await mode.handleJobsCommand({ full: true });
			await term.waitFor(screen => screen.join("\n").includes("Background Jobs"));
			const report = term.screen().join("\n");
			expect(report).toContain("worker cargo test");
			expect(report).not.toContain("main-only build");
		} finally {
			for (const gate of gates) gate.resolve("done");
			await worker.dispose();
		}
	});

	it("lists subagents' jobs under the task job that runs them, the deepest branch first", async () => {
		const registry = AgentRegistry.global();
		const refs = [
			registry.register({ id: "Worker", displayName: "task", kind: "sub", parentId: "main", session: null }),
			registry.register({ id: "Deep", displayName: "task", kind: "sub", parentId: "Worker", session: null }),
		];
		const gates = Array.from({ length: 4 }, () => Promise.withResolvers<string>());
		manager.register("bash", "main lint", () => gates[0].promise, { ownerId: "main" });
		manager.register("task", "audit the worker", () => gates[1].promise, { ownerId: "main", agentId: "Worker" });
		manager.register("bash", "worker build", () => gates[2].promise, { ownerId: "Worker" });
		const deepId = manager.register("bash", "deep probe", () => gates[3].promise, { ownerId: "Deep" });
		try {
			native = false;
			await mode.handleJobsCommand({ full: true });
			await term.waitFor(screen => screen.join("\n").includes("Background Jobs"));
			const report = term
				.screen()
				.map(line => line.replace(/^│ ?|\s*│$/g, "").trimEnd())
				.filter(line => /\S/.test(line));
			const at = (text: string) => report.findIndex(line => line.includes(text));
			// Worker's branch (Deep's header and job, then its own job) leads; main's own leaf trails.
			expect(report[at("audit the worker") - 1]).toMatch(/^\S+ \[task\] running \(.*\) Worker$/);
			expect(report[at("Deep")]).toBe("├─ Deep");
			expect(report[at("deep probe")]).toMatch(/^│ {7}deep probe$/);
			expect(report[at("worker build")]).toMatch(/^ {5}worker build$/);
			expect(at("audit the worker")).toBeLessThan(at("Deep"));
			expect(at("deep probe")).toBeLessThan(at("worker build"));
			expect(at("worker build")).toBeLessThan(at("main lint"));

			// The sheet steps past Deep's header to its job, which main can inspect.
			expect(mode.dismissCommandReport()).toBe(true);
			native = true;
			await mode.handleJobsCommand();
			await term.waitFor(screen => screen.join("\n").includes("deep probe"));
			term.press("down");
			await term.settle();
			expect(term.screen().join("\n")).toMatch(/> .*running {2}bash .* deep probe/);
			expect(session.inspectAsyncJob(deepId)).toMatchObject({ pids: [] });
			term.press("escape");
		} finally {
			for (const gate of gates) gate.resolve("done");
			for (const ref of refs) registry.unregister(ref.id, ref);
		}
	});
});
