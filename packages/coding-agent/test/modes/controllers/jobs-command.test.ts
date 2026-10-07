import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Container } from "@oh-my-pi/pi-tui";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { JobsSheet } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const WIDTH = 60;

/** `/jobs full` in text mode, as the report box above the editor shows it: its content rows, borders stripped. */
async function renderFullJobs(running: AsyncJobSnapshotItem[]): Promise<string[]> {
	const reportContainer = new Container();
	const ctx = {
		ui: { terminal: { columns: WIDTH, rows: 200 }, requestRender: () => {} },
		keybindings: { getKeys: () => ["escape"] },
		reportContainer,
		commandReportRows: () => 200,
		composerInputAtBottom: () => false,
		session: {
			getAsyncJobSnapshot: () => ({
				running,
				recent: [],
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			}),
		},
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleJobsCommand({ full: true });
	return reportContainer
		.render(WIDTH)
		.map(line => Bun.stripANSI(line))
		.filter(line => line.startsWith("│"))
		.map(line => line.slice(2, -2).trimEnd());
}

describe("CommandController /jobs full", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps every line of a multi-line or wrapped command indented under its job row", async () => {
		const longLine = `python /tmp/x.py ${"--flag ".repeat(12)}END`;
		const command = `cat <<'EOF' > /tmp/x.py\nimport sys\nEOF\n${longLine}`;
		const startTime = Date.now();
		const lines = await renderFullJobs([
			{ id: "bash-1", type: "bash", status: "running", label: "cat <<'EOF'...", command, startTime },
			{ id: "bash-2", type: "bash", status: "running", label: "sleep 5", startTime },
		]);

		const first = lines.findIndex(line => line.includes("bash-1"));
		const second = lines.findIndex(line => line.includes("bash-2"));
		const commandLines = lines.slice(first + 1, second);
		// Job rows start the report body; command lines sit two columns deeper.
		expect(lines[first]).toMatch(/^\S/);
		expect(commandLines.length).toBeGreaterThan(4);
		for (const line of commandLines) expect(line).toMatch(/^ {2}\S/);
		expect(commandLines.map(line => line.trim()).join(" ")).toContain("import sys EOF python /tmp/x.py --flag");
		expect(commandLines.at(-1)).toEndWith("END");
		expect(lines[second + 1]).toBe("  sleep 5");
	});
});

describe("/jobs in the native terminal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let mode: InteractiveMode;
	let wasNative: boolean;

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
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
		});
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
		wasNative = isNativeRendering();
		setNativeRendering(true);
	});

	afterEach(async () => {
		setNativeRendering(wasNative);
		mode?.stop();
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
		manager.register("bash", "cargo test --workspace", () => gate.promise);
		const transcript = [...mode.chatContainer.children];

		await mode.handleJobsCommand();

		const sheet = mode.ui.overlayStack.at(-1)?.component;
		expect(sheet).toBeInstanceOf(JobsSheet);
		expect(mode.ui.getFocused()).toBe(sheet ?? null);
		expect(Bun.stripANSI(sheet?.render(100).join("\n") ?? "")).toContain("cargo test --workspace");
		expect(mode.chatContainer.children).toEqual(transcript);

		sheet?.handleInput?.("\x1b");
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.chatContainer.children).toEqual(transcript);
		gate.resolve("done");
	});
});
