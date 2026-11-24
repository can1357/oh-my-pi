/**
 * The working row's session accent follows the session mid-run, as the old loader re-read it per
 * frame: a rename recolors the running row, and turning `statusLine.sessionAccent` off drops it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgStatusLineSessionAccent } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";

function find(node: UiNode, role: string): UiNode | undefined {
	if (node.props().role === role) return node;
	for (const child of node.children()) {
		const found = find(child, role);
		if (found) return found;
	}
	return undefined;
}

describe("working row session accent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-working-accent-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** The running row's terminal accent (its main hex), or undefined without one. */
	const accent = (): string | undefined => {
		const row = mode.shell.surface
			.dock()
			.map(node => find(node, "omp.working"))
			.find(node => node !== undefined);
		if (!row) throw new Error("expected the working row");
		return (row.props() as { term?: { accent?: { main: string } } }).term?.accent?.main;
	};

	it("recolors the running row when the session is renamed, and drops the accent when it is turned off", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await session.sessionManager.setSessionName("Audit the parser", "user");
		mode.ensureWorkingRow();
		const first = accent();
		expect(first).toMatch(/^#/);

		await session.sessionManager.setSessionName("Ship the renderer", "user");
		const renamed = accent();
		expect(renamed).toMatch(/^#/);
		expect(renamed).not.toBe(first);

		cfgStatusLineSessionAccent.set(settings, false);
		mode.statusLine.reloadSettings();
		expect(accent()).toBeUndefined();
		mode.clearWorking();
	});
});
